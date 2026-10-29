# Single entry point for checks, used by people, agents and CI.
#   make check   clean install, formatting, types, unit tests, build, then ESLint + web-ext lint on dist/

.PHONY: check
check:
	npm ci
	npx prettier --check .
	npm run typecheck
	npm test
	npm run build
	npm run lint
