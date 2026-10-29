# RedditHide

A Firefox extension for **new Reddit** (`www.reddit.com`). It records the subreddits you see, classifies each one with an LLM you configure (topic, language, NSFW-sexual, gross, plus your own attributes), and hides posts from subreddits that match your filter rules. Everything runs inside the extension. The only outbound traffic goes to reddit.com (your normal browsing) and the LLM endpoints you configure.

Firefox only (128+). You bring your own LLM: an API key for a hosted provider, or a local server such as Ollama.

The full brief is in [SPEC.md](SPEC.md). This build covers milestones 1–4: capture, enrichment, providers and classification, filters and hiding. Milestones 5–6 (exports, backup/restore, compare page) are not built yet.

## Install (temporary, via about:debugging)

```sh
npm install
npm run build          # writes dist/
```

1. Open `about:debugging#/runtime/this-firefox` in Firefox 128 or newer.
2. Click **Load Temporary Add-on…** and pick `dist/manifest.json`.
3. The options page opens. Add a provider (see below).
4. Browse new Reddit. If the popup shows **Grant access to reddit.com**, click it. Current Firefox grants the reddit.com permission at install, but older versions may not.

Other scripts:

| Command               | What it does                                    |
| --------------------- | ----------------------------------------------- |
| `npm run build`       | Production build into `dist/`                   |
| `npm run watch`       | Rebuild on change                               |
| `npm test`            | Vitest unit tests                               |
| `npm run typecheck`   | `tsc --noEmit`                                  |
| `npm run lint`        | ESLint + `web-ext lint` (run `build` first)     |
| `npm run start`       | `web-ext run` with the built extension          |
| `npm run package`     | Zip for distribution (`web-ext build`)          |
| `npm run build:debug` | Build with the debug bridge (see "Development") |

## Providers

Options → **Providers** → pick a preset → **Add provider**. Fill in the model and API key, then **Save**. Saving asks Firefox for permission to contact that origin. **List models** fills the model dropdown, and **Test** classifies a built-in sample subreddit and shows the raw response, the parsed result and the latency.

| Preset                          | Base URL                       | Notes                                                                            |
| ------------------------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| Anthropic                       | `https://api.anthropic.com`    | Suggested model `claude-haiku-5-5`. See "Anthropic details" below.               |
| OpenAI                          | `https://api.openai.com/v1`    | `native` = JSON-schema structured output                                         |
| OpenRouter                      | `https://openrouter.ai/api/v1` | Optionally add `{"HTTP-Referer": "…", "X-Title": "RedditHide"}` as extra headers |
| Moonshot (Kimi), DeepSeek, Groq | see presets                    | Default to `json_object`                                                         |
| Ollama (local)                  | `http://localhost:11434/v1`    | Needs the CORS setting below                                                     |
| LM Studio (local)               | `http://localhost:1234/v1`     |                                                                                  |
| Custom                          | —                              | Any OpenAI-compatible server (llama.cpp server, vLLM, …)                         |

If a provider rejects `native` structured output with a 400 that mentions `response_format`, the extension shows a hint. Switch that profile to `json_object` or `prompt_only`. It never switches modes on its own.

Set a **fallback** profile to retry once on a different provider when the default one refuses.

API keys are stored **unencrypted** in the extension's local storage. Use keys with spending limits. Keys are masked in the UI (last 4 characters) and scrubbed from error messages.

### Ollama: allow the extension's origin

Ollama rejects requests from browser extensions unless you allow their origin. Without that, requests fail with HTTP 403 (verified 2026-10-16). Start Ollama with:

```sh
OLLAMA_ORIGINS="moz-extension://*" ollama serve
```

With Docker:

```sh
docker run -d --name ollama -p 11434:11434 -e OLLAMA_ORIGINS="moz-extension://*" -v ollama:/root/.ollama ollama/ollama
```

For a systemd service, add `Environment="OLLAMA_ORIGINS=moz-extension://*"` with `systemctl edit ollama`.

### Anthropic details

The connector calls `POST /v1/messages` directly with `anthropic-dangerous-direct-browser-access: true`. Two deliberate deviations from SPEC §6.4:

- **`native` mode uses structured outputs** (`output_config.format` with a JSON schema) instead of a forced tool call. Forced `tool_choice` returns HTTP 400 on current models (Opus 5.5, Sonnet 5.5, Fable 5.1).
- **No `temperature` on current models.** Claude 5.x, Fable and Opus 4.7/4.8 reject non-default sampling parameters. These models also think by default, so the request sets `effort: "low"` and `max_tokens: 4096` (instead of 1024) to leave room for the answer.

## How classification works

1. **Capture.** The content script watches the feed (home, `/r/popular`, `/r/all`, subreddit pages, search results, comment pages). It records each subreddit, the post titles it sees, and Reddit's per-post `post-language` tag. On a subreddit page it also reads the header (description, weekly visitors). Search results also give Reddit's subreddit NSFW flag.
2. **Waiting for titles.** A subreddit is classified once **3 distinct titles** have been seen, or **6 hours** after first sight with at least one title. Both thresholds are configurable under Options → Behavior. Visiting the subreddit's page, or clicking **Reclassify**, classifies it right away.
3. **Language.** Reddit's `post-language` tags win when at least 3 posts agree at 70% or more, because titles in the DOM can be machine-translated for logged-in users. Otherwise `browser.i18n.detectLanguage` runs on the description and titles. When neither is reliable, the model is asked for a guess.
4. **LLM.** One request per subreddit. The result is validated with zod, and invalid output gets one retry that includes the error. Unknown topics map to `other`, and the mapping is logged.
5. **NSFW rule (§7.4).** Final `nsfw_sexual` = (Reddit over18 flag **and** the model says true) **or** the model says true with confidence ≥ 0.8. The model's raw answer is kept and shown in the review drawer.
6. **Rubric version.** A hash of the prompt template, the enabled attribute definitions and the topic list. After you edit any of them, the review page offers to re-run outdated classifications. It never re-runs automatically.

### Reddit JSON enrichment is not active

The spec calls for `about.json` and `top.json`. Reddit currently blocks those endpoints for logged-out clients ("You've been blocked by network security", HTTP 403, checked 2026-10-16), so metadata and sample titles come from the DOM instead. The pipeline is built from pluggable stages (`src/background/pipeline.ts`, `LOCAL_STAGES`). Adding a Reddit-JSON stage later means replacing `domMetaStage` and adding a samples stage, plus a reddit.com rate limiter that honors the request-interval setting.

## How filters work

Review page → **Filter lists**. A filter list is a tree of groups (`any` / `all`) and conditions:

- **Attributes:** any enabled attribute, plus `subscribers` (weekly visitors until subscriber counts are available) and `over18_flag`.
- **Operators:** `is`, `is not`, `is one of`, `is none of`, `includes any of`, `includes none of`, `≥`, `≤`, depending on the attribute type.
- **Min confidence** (default 0.6): below it the condition is false. A condition on an unknown value is also false, so a subreddit with language `und` (confidence 0) doesn't match `language is none of [en]`.
- **Empty groups match nothing**, so a new list hides nothing.
- Manual corrections (overrides) in the review drawer always win over the model.

The **effective block set** = (rule matches ∪ always-block) − always-allow. The live preview shows which subreddits the rule matches before you save.

### Hiding

- **Collapse** (default) replaces the post with a one-line placeholder: `Hidden: r/foo — gross, topic: crypto [show]`. Clicking it reveals the post.
- **Remove** hides the post and the divider after it.
- **Never on the subreddit you browsed to** (`/r/foo`, also with SPA navigation), configurable.
- **Hide unclassified** hides posts from any subreddit that hasn't been classified yet.
- The toolbar badge and the popup show how many posts are hidden on the current page.

The content script runs at `document_start` and marks posts in its MutationObserver callback, before they are painted. On the live site, all 84 posts that should have been hidden across 12 infinite-scroll steps were already marked when they reached the DOM.

## New-Reddit DOM notes (verified 2026-10-16)

All selectors live in [`src/content/selectors.ts`](src/content/selectors.ts).

- Feed posts are `shreddit-feed > article > shreddit-post[subreddit-name][subreddit-prefixed-name][post-title][post-language][id]`, each followed by an `<hr>`. The `article` is what gets hidden.
- The feed is virtualized: off-screen articles are replaced by `div.virtualized-placeholder` elements sized to the measured height, so a hidden (zero-height) article leaves no gap.
- Search results are not `shreddit-post`. They are `search-telemetry-tracker[view-events="search/view/post"]` with a JSON `data-faceplate-tracking-context` attribute (post id/title, subreddit name/nsfw/quarantined).
- The main post on a comments page has `view-context="CommentsPage"`. It is recorded but never hidden.
- Navigation is client-side (same document). The content script polls `location.href` and also checks it in the MutationObserver.

## Not built yet

- **Milestone 5:** exports (plain text, comma-separated, uBlock Origin, RES) and full backup/restore. The Data tab currently has "Clear subreddit data" and "Reset everything".
- **Milestone 6:** compare page. The usage table and outdated-rubric re-run prompt already exist.

## Development

- `tests/fixtures/*.html` are trimmed snapshots of the live DOM, used by the extraction tests.
- **Debug bridge:** browser automation can't script `moz-extension://` pages, so `npm run build:debug` adds a content script that relays `window.postMessage({rhDebug: method, id, params})` from a reddit.com tab to the background RPC (plus `storageGet`/`storageSet`). Normal builds don't include it, and the background then accepts RPC only from extension pages.
- The background stores everything in IndexedDB (`reddithide`). Only the background touches it. Settings live in `browser.storage.local`, and the published block set (`blockSet` key) is how content scripts receive updates.
