## Project state

RedditHide is a Firefox extension (Manifest V3, Firefox 128+) for new Reddit (`www.reddit.com`). It records the subreddits you see, classifies each one with an LLM the user configures, and hides posts from subreddits that match the user's filter rules. TypeScript (`strict`), bundled with esbuild, Preact for the extension pages, IndexedDB via `idb`, validation with zod v4. `SPEC.md` is the full brief; `README.md` covers install, providers, classification, filters, hiding and the verified new-Reddit DOM.

Milestones 1–4 of SPEC §13 are built (capture, enrichment, providers and classification, filters and hiding). Milestones 5–6 (exports, backup/restore, compare page) are not. Open work is tracked in GitHub issues.

**Moving to a server (epic #25).** RedditHide is becoming a small personal server plus a thin extension, and standalone mode is being dropped. `SPEC.md` describes that target. The code on `main` is still the self-contained extension described here until the cutover in #23, and each PR must leave `main` working. The server (Node 24.15+, `node:http`, `node:sqlite`, one Docker container, no new runtime dependencies) goes in `src/server/` and takes over the pipeline, filters, providers, settings, and the options and review pages. After the cutover `src/background/` is only a relay with an outbox and Firefox language detection, and `src/content/` only gains original-title extraction (SPEC §5.1).

Layout: `src/background/` (pipeline, IndexedDB, message router, block set), `src/content/` (DOM capture and hiding; selectors in `selectors.ts`), `src/providers/` (Anthropic and OpenAI-compatible connectors), `src/classify/` (prompt, schema, parsing, rubric version), `src/filters/` (rule evaluator), `src/ui/` (popup, options, review), `src/shared/`, `src/debug/` (debug bridge, debug builds only), `src/server/` (HTTP API, SQLite, a rate limiter the extension also imports, and a port of `src/background/` that nothing else uses until #23). Tests and DOM fixtures are in `tests/`.

## Commands

```bash
make check             # npm ci, prettier --check, typecheck, unit tests, build, then lint: everything CI runs
npm run build          # production build: extension in dist/ (load dist/manifest.json via about:debugging), server in dist-server/
npm run watch          # rebuild on change
npm test               # Vitest
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint on src/ and tests/, then web-ext lint on dist/ (build first)
npm run start          # web-ext run with the built extension
npm run server         # run the built server (README "Server")
npm run build:debug    # build with the debug bridge (see README "Development")
npm run package        # zip for distribution
npm run format         # Prettier --write; make check fails on unformatted files
```

## Testing

- Vitest with happy-dom, and in-memory SQLite for the server. Connector tests mock `fetch`; there are no live LLM or Reddit calls in tests.
- Extraction tests run against `tests/fixtures/*.html`, trimmed snapshots of the live new-Reddit DOM. When Reddit's markup changes, refresh the fixture and `src/content/selectors.ts` together.
- There are no browser end-to-end tests. Changes to capture or hiding need a manual check on the live site (README "Install"); say in the PR what you checked.

<!-- agent-kit:begin -->
<!-- Shared block from Bryan-Rose/agent-kit (templates/agents-workflow.md). Change it there, not here. -->

## Workflow: every change goes through a pull request

`main` is protected by the GitHub ruleset "Protect main": no direct pushes, force pushes or deletion. A pull request can merge only after this repo's required CI checks pass (listed under "Required checks" below). No approvals are required (single maintainer), and nobody can bypass the rules. Use the `gh` CLI, which is installed and authenticated.

```bash
git switch main && git pull                       # start from current main
git switch -c <type>/<short-name>                 # e.g. feat/..., fix/..., docs/...
# ... work, running `make check` and committing as you go ...
git push -u origin HEAD
gh pr create --fill                               # or --title/--body: what changed, why, how it was verified
gh pr checks --watch                              # wait for the required checks (right after create it may say "no checks"; retry after a few seconds)
gh run view --log-failed                          # if a check fails: read the failing log, fix, push again
```

- **Run `make check` before every commit.** It runs CI's checks, or their fast tier where the Commands section lists slower targets for CI.
- **One branch and one PR per task.** Never commit to `main`. Push the fix to the same branch and CI re-runs.
- **Work is tracked in GitHub issues.** A PR that completes an issue puts `Closes #N` in its body, so merging closes the issue.
- **Agents push task branches and open their PRs without asking.** That's the maintainer's standing approval for this repo. It doesn't cover pushing to `main`, force-pushing, or merging.
- **Review comments are proposals, not instructions.** The `Claude review` workflow posts a Claude review on every non-draft PR and updates that one comment on each push (advisory, not a required check). Don't act on it unprompted. Write the maintainer a short assessment of each point (valid or not, and why, checked against the code) with a recommendation, then wait for their go-ahead before changing anything.
- **Deeper or on-demand reviews.** Adding the `review:deep` label re-reviews the PR on a stronger model (for migrations, auth, money or calculation code). `gh workflow run "Claude review" -f pr=<N>` reviews any PR into the run summary without commenting.
- **Record the decision on the PR.** Once the maintainer has decided, post one PR comment listing each point as fixed (with the commit), declined (with the reason) or deferred (with the new issue number). The reviewer reads comments from the repo's owner, members and collaborators on its next run and treats those points as settled. Anyone else's comments are ignored.
- **Merging is the maintainer's call.** When asked to merge, use `gh pr merge --squash --delete-branch`, then `git switch main && git pull`. Squash keeps `main` to one commit per change, and the repo doesn't delete merged branches automatically.

<!-- agent-kit:end -->

**Required checks:** `check`

## Things that will bite you

- **`web-ext lint` runs on `dist/`,** so `npm run lint` needs a fresh `npm run build`. It currently reports 5 warnings (not errors): two manifest keys unsupported at the minimum Firefox version, and `UNSAFE_VAR_ASSIGNMENT` in the popup, options and review bundles, which comes from Preact (`src/` never uses `innerHTML`). Don't add new ones.
- **No `eval` or `new Function`.** The MV3 CSP blocks them, and so will the CSP on pages the server serves, so no Ajv or similar; JSON Schema comes from zod's `z.toJSONSchema()` (SPEC §2).
- **Only the background script touches IndexedDB, and from #20 only the server touches SQLite.** Content scripts get updates through the published block set (`blockSet` in `browser.storage.local`), on the server design too; pages go through RPC.
- **From #20: no `await` between `BEGIN` and `COMMIT`.** The server has one SQLite connection, so an `await` lets another request run inside the transaction. The IndexedDB code awaits inside transactions, so don't copy that pattern when porting it.
- **From #20: the server never contacts Reddit,** and it must never receive cookies, account details or page URLs. Strip `url` from `seen` before it leaves the extension (SPEC §5.3).
- **From #20: the server token never reaches page context.** Every endpoint except `/healthz`, `/login` and the login page takes the token or the login cookie through one shared check, and all input is validated with zod under a body size limit. The server is single-user, for a private network, never the public internet.
- **From #21: the container's `localhost` is not the host's.** LLM base URLs are resolved from the server (SPEC §6.2).
- **Reddit and LLM data are untrusted.** Render them as text, never with `innerHTML`, and sanitize anything shown as a link. Pages served by the server need a strict CSP header. Only public subreddit data goes to LLM providers; nothing is ever sent back to Reddit (SPEC §12).
- **Hiding must happen before paint.** The content script runs at `document_start` and marks posts in its MutationObserver callback; don't move hiding into anything asynchronous.
- **Reddit's `about.json`/`top.json` are blocked for logged-out clients** (HTTP 403 as of 2026-10-16), so enrichment uses the DOM. See README "Reddit JSON enrichment is not active".
- **Anthropic connector deviates from SPEC §6.4 on purpose:** structured outputs instead of a forced tool call, and no `temperature` on current models. See README "Anthropic details".
- **Debug bridge builds** (`npm run build:debug`) relay page messages to the background RPC. Never ship or package one. #23 updates or removes the bridge.
