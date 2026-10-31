FROM node:24.18-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24.18-slim
ENV HOST=0.0.0.0 PORT=8787 DB_PATH=/data/reddithide.db
WORKDIR /app
# .mjs because there is no package.json here to mark the bundle as an ES module.
COPY --from=build /app/dist-server/index.js index.mjs
# Before VOLUME, so a new named volume starts out owned by node.
RUN mkdir /data && chown node:node /data && chmod 700 /data
VOLUME /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "index.mjs"]
