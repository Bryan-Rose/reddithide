# RedditHide — Specification

A Firefox extension plus a small personal server. The extension records the subreddits a user encounters on **new Reddit** (`www.reddit.com`) and hides posts on the page. The server classifies each subreddit automatically with a configurable LLM, holds the only copy of the data, and works out which subreddits match the user-defined filter rules. It can also export the resulting block lists for other tools.

This document is the full brief. It assumes no prior context. Where it says **VERIFY**, the information came from memory or may have changed; check it against the live site or the official documentation before relying on it.

**Status:** this spec describes the server design. `main` stays a self-contained extension until the cutover in issue #23. Epic #25 tracks the steps.

---

## 1. Goals and non-goals

### Goals
1. **Capture**: record every subreddit whose posts appear in the user's feeds and searches on new Reddit, with no action from the user.
2. **Enrich**: collect public metadata and sample post titles for each subreddit from the pages the user browses.
3. **Classify automatically**: assign attributes (topic, language, NSFW-sexual, gross, plus user-defined ones) using software, not the user. The user does not tag subreddits by hand. They can correct a label, but that is optional.
4. **Swappable LLM back ends**: Anthropic Claude, OpenAI, any OpenAI-compatible hosted provider (Kimi/Moonshot, DeepSeek, Groq, OpenRouter, Together, Mistral, …), and local models (Ollama, LM Studio, llama.cpp server, vLLM).
5. **Filter**: the user builds rules over the attributes (e.g. `language != en OR gross = true OR topic in {crypto, sports}`). Posts from matching subreddits are hidden on new Reddit.
6. **Export**: block lists as plain text, uBlock Origin cosmetic filters, and RES (Reddit Enhancement Suite) format. See §10 for why RES is secondary.
7. **One copy across devices**: desktop and phone share the same data, provider setup and block set. Data survives browser restarts. A subreddit is classified once per rubric version, and again only when it is due (§5.2).

### Non-goals (v1)
- Chrome or Safari support. Keep browser-specific code isolated so a port stays possible, but don't test it.
- old.reddit.com support.
- Classifying individual posts. The unit of classification is the subreddit.
- A standalone mode without the server. Two full copies of the app would need a merge engine, and a provider setup per device, and a phone cannot reach a local LLM.
- Multiple users, or a server exposed to the public internet (§12).
- Using the Reddit OAuth API or Reddit's "mute community" feature.

### Important constraint
The user browses **new Reddit**. RES does **not** run on new Reddit; it only supports old.reddit. That is why this extension must do the hiding itself (§9). RES export is a secondary feature for the user's other setups.

---

## 2. Tech stack (decided; do not change without reason)

| Concern | Choice |
|---|---|
| Extension platform | Firefox WebExtension, **Manifest V3**, `background.scripts` (event page, not service worker) |
| Minimum Firefox | 128 (ESR) |
| Server platform | Node 24.15+, `node:http`, `node:sqlite`, one Docker container. No new runtime dependencies |
| Language | TypeScript, `strict: true` |
| Bundler | esbuild (one bundle per entry point, plus a server build target) |
| UI | Preact for the popup and the server's pages; plain DOM in content scripts |
| Server storage | SQLite (§4), one connection, accessed **only from the server** |
| Extension storage | `browser.storage.local`: the cached block set, the outbox, the server URL and the token |
| Validation | `zod` v4, using `z.toJSONSchema()` to generate JSON Schema for LLM requests. **Do not use Ajv or any library that calls `eval`/`new Function`**, because the CSPs block them on extension pages and on the pages the server serves. |
| Browser API | `webextension-polyfill` types / the `browser.*` namespace |
| Dev tooling | `web-ext` (run, lint, build), Vitest (unit tests), ESLint + Prettier |

Two parts, one copy of the data:

- **Extension (thin).** `src/content` captures and hides. Hiding reads the cached `blockSet` from `storage.local` before paint, so it keeps working while the server is unreachable. A small background script relays captures to the server and refreshes the block set (§5.3). The popup keeps status, the on/off switch and the Reddit permission check, and gains server URL and token fields.
- **Server.** Holds the pipeline, filters, providers, settings, and the options and review pages. It serves plain HTTP on one port. HTTPS and network access are handled outside this repo. It never contacts Reddit.

Directory layout (suggested):
```
src/
  background/       relay to the server, outbox, block set refresh
  content/          DOM capture + hiding on reddit.com
  server/           HTTP API, SQLite db, pipeline, ingest, rate limiters, RPC router, block set, backups
  providers/        LLM connectors (anthropic.ts, openaiCompatible.ts, types.ts)
  classify/         prompt building, schema, response parsing, rubric versioning
  filters/          rule model + evaluator
  export/           exporters
  ui/popup/         extension popup
  ui/options/  ui/review/  ui/compare/   pages served by the server
  shared/           types, messages, constants
tests/              unit tests + DOM fixtures
manifest.json
```

---

## 3. Manifest and permissions

- `browser_specific_settings.gecko.id`: `reddithide@bryanrose.net` (required for storage in MV3).
- `permissions`: `storage`, `unlimitedStorage`, `alarms`. `unlimitedStorage` stops a full outbox (§5.3) from hitting a quota, which could also block block set writes.
- `host_permissions`: `*://*.reddit.com/*`.
- `optional_host_permissions`: `*://*/*`, because the server URL is entered at runtime. When the user saves the server URL, call `browser.permissions.request({ origins: [<server origin>/*] })` **inside the click handler** (it needs a user gesture). Request that origin only.
- Content script: matches `*://www.reddit.com/*`, `run_at: document_start`.
- **VERIFY**: in Firefox MV3, host permissions may not be granted at install. On startup, check `browser.permissions.contains` for reddit.com. If it's missing, the popup shows a "Grant access to reddit.com" button.

---

## 4. Data model (SQLite)

One SQLite database on the server, on a Docker volume. Every timestamp is epoch milliseconds.

**Transactions are synchronous: no `await` between `BEGIN` and `COMMIT`.** There is one connection, so an `await` would let another request run inside the transaction.

### Table `subreddits`
Columns: `name` (primary key), `pipeline_state` and `pending_at` (both indexed), and the record below as JSON. `name` is the lowercased subreddit name without the `r/` prefix.

```ts
interface SubredditRecord {
  name: string;                 // "askhistorians"
  displayName: string;          // "AskHistorians" (as seen)
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;            // incremented at most once per page load per subreddit

  meta?: {
    fetchedAt: number;
    source: 'dom' | 'reddit_json';  // 'dom' is the only source today; see #10
    status: 'ok' | 'private' | 'banned' | 'quarantined' | 'not_found' | 'error';
    title?: string;
    publicDescription?: string;
    sidebar?: string;           // markdown "description", truncated to 4000 chars
    over18?: boolean;
    quarantined?: boolean;
    lang?: string;              // Reddit's own field; often unreliable
    subscribers?: number;
    weeklyActiveUsers?: number;
    subredditType?: string;     // public | restricted | private | ...
    createdUtc?: number;
  };

  samples?: {
    fetchedAt: number;
    source: 'dom' | 'reddit_json';
    titles: string[];           // up to 25, most recent first
    items?: {
      id: string;
      title: string;            // as shown, may be machine-translated
      originalTitle?: string;   // original wording from the post's link, may be cut off (§5.1)
      lang?: string;            // Reddit's post-language tag
      browserLang?: string;     // Firefox's result on the original wording, when reliable (§5.3)
      seenAt: number;
    }[];
  };

  languageEvidence?: {          // per-subreddit summaries of samples.items, see §5.2
    reddit?: { code: string; count: number; total: number };   // und tags not counted
    firefox?: { code: string; count: number; total: number };
  };

  classification?: ClassificationResult;      // current
  classificationHistory?: ClassificationResult[]; // previous, keep last 5
  overrides?: Record<string, AttributeValue>; // optional manual corrections; always win
  pipelineState: PipelineState;
  lastError?: { at: number; stage: string; message: string };
  attempts: number;
  pendingAt?: number;           // set only while a reclassification is queued
  pendingReclassify?: { requestedAt: number; profileId?: string; isFallback?: boolean };
  retryAfter?: number;          // earliest retry after a transient error
}

type PipelineState =
  | 'discovered' | 'meta_done' | 'samples_done' | 'language_done'
  | 'classified' | 'refused' | 'failed' | 'skipped'; // skipped = private/banned/not_found

interface ClassificationResult {
  classifiedAt: number;
  profileId: string;
  providerKind: 'anthropic' | 'openai-compatible';
  model: string;
  rubricVersion: string;        // see §7.5
  values: Record<string, { value: AttributeValue; confidence: number; reason: string }>;
  summary: string;              // one-line description of the subreddit
  usage?: { inputTokens?: number; outputTokens?: number };
}

type AttributeValue = boolean | string | string[];
```

### Table `usage`
One row per LLM call: `{ id, at, profileId, model, inputTokens, outputTokens, ok: boolean }`. Used for cost display.

### Settings (SQLite)
A key-value table holds each setting as JSON, along with the runtime status and the current block set. Code that needs to react to a change is notified directly when a setting is saved.

- `attributes: AttributeDef[]` (§7.1)
- `topics: string[]` (§7.2)
- `profiles: ProviderProfile[]` (§6)
- `defaultProfileId`, `fallbackProfileId?`
- `filterLists: FilterList[]` (§8), `activeFilterListId`
- `manualBlock: string[]`, `manualAllow: string[]`. Allow always wins over block.
- `behavior`: §9 options
- `enrichment`: `{ minSamples, maxWaitHours }` (§5.2)
- `queue`: `{ paused: boolean }`

### Backups
A nightly `VACUUM INTO` writes a copy of the database to `backups/` beside it, one per UTC day, and keeps 7 copies. The server checks hourly, so it catches up after downtime. A failed backup is reported as a runtime error. Restoring means putting one back as the database file. The database and its backups hold API keys unencrypted, so the owner must treat them as secrets.

Data in a standalone extension is not migrated. The server starts empty.

### Extension storage (`browser.storage.local`)
- `blockSet`: the last block set received (§8), read by content scripts before paint
- The outbox of unsent captures (§5.3)
- The server URL and token

---

## 5. Capture, server pipeline and API

### 5.1 Capture (content script)
New Reddit is built from web components. **VERIFY** the selectors below against the live DOM before coding, and keep every selector in one module (`src/content/selectors.ts`) so it's easy to fix when Reddit changes its markup.

- Posts appear as `<shreddit-post>` elements, with attributes including `subreddit-name`, `subreddit-prefixed-name` (`r/foo`), `subreddit-id`, `post-title`, `permalink`. (Last seen around 2025; **VERIFY**.)
- Feeds scroll forever. Use one `MutationObserver` on `document.body` that handles added nodes, plus a first pass over existing posts. Reddit is a single-page app, so also re-scan when the URL changes. Detect that by polling `location.href` or listening for `popstate`, and **VERIFY** how navigation behaves.
- Surfaces to cover: home, `/r/popular`, `/r/all`, search results, and subreddit pages (record the subreddit itself). Comment pages: record the post's subreddit only.
- Send discoveries to the background in batches of up to 50 names, at most once a second, with the message `{ type: 'seen', names: [{ name, displayName, sighting, posts?, over18?, quarantined? }], url }`. `posts` are `{ id, title, lang?, originalTitle? }`. The relay removes `url` (§5.3).
- `post-title` is translated when Reddit translates a post, but the link keeps the original wording: `/r/de/comments/1mlniax/reddit_verlangt_altersverifikation_in_deutschland/` for "Reddit requires age verification in Germany". `originalTitle` is that last path segment with underscores replaced by spaces. It is lowercase, without punctuation, and may be cut off. Leave it out when the segment is empty or `_`. Only these words are sent, never the link. Seen in the `?tl=en` view while logged out. **VERIFY** with a logged-in translated feed, and with titles in non-Latin scripts.
- On a subreddit page, also send `{ type: 'subredditMeta', name, displayName, meta: { title?, publicDescription?, weeklyActiveUsers? } }` from the page header.
- Ignore user-profile posts (`u_username` subreddits). Detect them by the `u_` prefix or the `u/` prefixed name.

**Tool tip:** the user has the `firefox-devtools` MCP server set up in Claude Code (`@mozilla/firefox-devtools-mcp`). If it's available to you, use `navigate_page` + `take_snapshot` / `evaluate_script` to inspect the live new-Reddit DOM, and save a trimmed HTML fixture of a feed into `tests/fixtures/` for the extraction unit tests. That Firefox instance has its own profile and is not logged in to Reddit unless the user logs in there.

### 5.2 Server pipeline
A persistent queue driven by state, kept in SQLite so it survives restarts. A one-minute timer wakes it, and so does new data.

For each subreddit, in priority order (higher `seenCount`, then more recent `lastSeenAt`), skipping when `queue.paused`:

1. **discovered → meta_done**: metadata comes from the DOM (subreddit header, search results) and is merged on ingest, so this stage only passes the record on.
2. **meta_done → samples_done**: waits until `enrichment.minSamples` titles (default 3) have been seen, or one title plus a description, or at least one title `enrichment.maxWaitHours` (default 6) after first sight. A queued reclassification skips the wait.
3. **samples_done → language_done**: builds `languageEvidence` from the sample items: the most common Reddit tag and Firefox result, each with its count. Neither decides the language on its own (§7.3).
4. **language_done → classified | refused | failed**: LLM classification (§7).

The server never fetches from Reddit, so there is no reddit.com rate limiter. `about.json` and `top.json` are blocked for logged-out clients; see #10.

Nothing sets `skipped` or a non-`ok` `meta.status` today, because the DOM doesn't reveal them. They stay reserved for #10.

Each stage writes only the field it changed. A stage must not write back fields from the copy it read earlier, because a `seen` update may have arrived in between.

Failures increment `attempts`; after 3 attempts the record goes to `failed` with `lastError` set.

**Re-classification:** a record is due again when (a) `rubricVersion` differs from the current version, (b) the classification is older than 180 days, or (c) the user asks for it (one subreddit, a selection, or all). Metadata and samples update whenever the extension sends newer data.

### 5.3 Extension relay
- The background script forwards `seen` and `subredditMeta` to the server, without the page URL.
- Before queueing a post, it runs `browser.i18n.detectLanguage` on `originalTitle`, or on `title` if there is none, and adds the code as `browserLang` when the result is reliable. The server has no such API. **VERIFY** how reliable this is on short, cut-off text, and that it works on Firefox for Android.
- Unsent captures wait in an outbox in `storage.local`, capped at 500 entries. When it is full, the oldest entries are dropped. The outbox is flushed on each new capture and on the one-minute alarm.
- The block set is fetched after each upload and on the alarm, using the ETag. It is written to `storage.local` only if its `updatedAt` is newer, so an out-of-order response cannot restore an older set. The server sets a fresh `updatedAt` on every start (§8), so a restored backup still reaches devices.
- While the server is unreachable, hiding continues from the cached set and captures wait in the outbox.
- `pageStats` and the toolbar badge stay in the extension.

### 5.4 Server API
| Endpoint | Purpose |
|---|---|
| `POST /api/seen` | The `seen` batch without `url`. Keeps the existing cap of 200 names |
| `POST /api/meta` | Subreddit title, description and weekly active users |
| `GET /api/blockset` | Current block set, with an ETag and `304` when unchanged |
| `POST /api/rpc/:method` | The existing typed RPC methods, returning `{ ok, result }` or `{ ok, error }`, plus `getSettings`, `saveSettings` and a full reset |
| `POST /login` | Exchanges the token for an `HttpOnly`, `SameSite=Strict`, `Secure` cookie for the server's pages |
| `GET /healthz` | `200` if the server can open its database. No auth and no data |

Every endpoint except `/healthz`, `/login` and the login page takes either the bearer token, compared in constant time, or the login cookie. This is one check in one place: the extension uses the token and browsers use the cookie. Cookie-authenticated requests other than GET and HEAD must have an `Origin` header equal to the server's public address. Browsers don't send `Origin` on page loads, and `SameSite=Strict` covers cross-site GETs. That address comes from the `PUBLIC_ORIGIN` environment variable (for example `https://reddithide.example.ts.net`). A missing or different `Origin` is rejected, and forwarded headers are not trusted. All input is validated with zod under a body size limit, because the server receives scraped page data.

---

## 6. LLM providers

### 6.1 Profile
```ts
interface ProviderProfile {
  id: string;                  // uuid
  name: string;                // "Claude Haiku", "Local Qwen", "Kimi"
  kind: 'anthropic' | 'openai-compatible';
  baseUrl: string;
  apiKey?: string;             // optional for local servers
  model: string;
  structuredOutput: 'native' | 'json_object' | 'prompt_only';
  temperature: number;         // default 0
  maxConcurrency: number;      // default 2 (local: 1)
  requestsPerMinute: number;   // default 30
  timeoutMs: number;           // default 60000 (local: 180000)
  extraHeaders?: Record<string, string>; // e.g. OpenRouter's HTTP-Referer / X-Title
  priceInputPerMTok?: number;  // optional, user-entered, for cost display only
  priceOutputPerMTok?: number;
}
```

### 6.2 Presets (options page "Add provider" menu)
These pre-fill `kind` and `baseUrl`. The user supplies the model name. **VERIFY** each base URL against the provider's current docs. Base URLs are resolved from the server, so inside the container `localhost` means the container itself. The local presets have a `<host>` placeholder, which the user replaces with an address the container can reach.

| Preset | kind | baseUrl |
|---|---|---|
| Anthropic | anthropic | `https://api.anthropic.com` |
| OpenAI | openai-compatible | `https://api.openai.com/v1` |
| OpenRouter | openai-compatible | `https://openrouter.ai/api/v1` |
| Moonshot (Kimi) | openai-compatible | `https://api.moonshot.ai/v1` |
| DeepSeek | openai-compatible | `https://api.deepseek.com/v1` |
| Groq | openai-compatible | `https://api.groq.com/openai/v1` |
| Ollama (local) | openai-compatible | `http://<host>:11434/v1` (placeholder, must be edited) |
| LM Studio (local) | openai-compatible | `http://<host>:1234/v1` (placeholder, must be edited) |
| Custom | openai-compatible | (blank) |

The options page has a **"List models"** button that calls `GET {baseUrl}/models` (OpenAI-compatible) or `GET https://api.anthropic.com/v1/models` (Anthropic) and fills a dropdown. It also has a **"Test"** button that classifies one hard-coded sample subreddit and shows the raw response, the parsed result and the latency.

For the Anthropic preset, suggest `claude-haiku-5-5` as the default model: classification doesn't need a large model.

### 6.3 Connector interface
```ts
interface ClassifyRequest {
  system: string;
  user: string;
  schema: object;        // JSON Schema generated from zod
  schemaName: string;    // "record_classification"
}
interface ClassifyResponse {
  json: unknown;         // parsed but not yet validated
  rawText: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  refused: boolean;
  refusalText?: string;
}
interface Connector {
  classify(profile: ProviderProfile, req: ClassifyRequest, signal: AbortSignal): Promise<ClassifyResponse>;
  listModels(profile: ProviderProfile): Promise<string[]>;
}
```

### 6.4 Anthropic connector
- `POST {baseUrl}/v1/messages`
- Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`, `anthropic-dangerous-direct-browser-access: true` (required for calls from a browser).
- Body: `model`, `max_tokens: 1024`, `temperature`, `system`, `messages: [{ role: 'user', content: user }]`.
- Structured output (`native`): define one tool `{ name: schemaName, description, input_schema: schema }` and force it with `tool_choice: { type: 'tool', name: schemaName }`. The result is the `input` of the `tool_use` content block.
- Refusal: `stop_reason === 'refusal'` (**VERIFY**), or no `tool_use` block when one was forced → `refused: true` with any text content saved in `refusalText`.
- Usage: `usage.input_tokens`, `usage.output_tokens`.

### 6.5 OpenAI-compatible connector
- `POST {baseUrl}/chat/completions`, `Authorization: Bearer <apiKey>` when a key is set, plus `extraHeaders`.
- Body: `model`, `temperature`, `messages: [{role:'system'}, {role:'user'}]`, and, depending on `structuredOutput`:
  - `native` → `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`
  - `json_object` → `response_format: { type: 'json_object' }`, with the schema written into the system prompt
  - `prompt_only` → no `response_format`; the schema goes in the prompt and the output is parsed leniently
- Parse `choices[0].message.content`. Remove ```` ``` ```` code fences, and if needed take the outermost `{...}` substring.
- Refusal: `choices[0].message.refusal` non-empty, or `finish_reason === 'content_filter'`.
- Usage: `usage.prompt_tokens`, `usage.completion_tokens`.
- Strict JSON-schema mode rejects some schema features. Generate the schema in a conservative form: every property required, `additionalProperties: false`, no `oneOf`, enums as plain string enums.
- If a provider answers `native` with a 400 that mentions `response_format`, show a hint suggesting `json_object` or `prompt_only` for that profile. Don't switch modes silently.

### 6.6 Shared behavior (both connectors)
- Validate `json` with the zod schema. On failure, retry **once** with an extra user turn: "Your previous output was invalid: <zod error summary>. Return only valid JSON matching the schema." If it fails again → `failed`.
- `refused` → state `refused`. If a `fallbackProfileId` is set and differs from the current profile, queue one retry on the fallback.
- HTTP errors:
  - 401/403 → pause the queue, show a popup message naming the profile.
  - 429 → respect `retry-after`, otherwise back off exponentially (30 s → 10 min).
  - 5xx or network error/timeout → retry up to 3 times with backoff.
- Per-profile concurrency and RPM limits are enforced on the server.
- Network errors against `localhost`: the message should say that the address is resolved from the server (§6.2). Calls come from the server, so browser CORS settings such as `OLLAMA_ORIGINS` no longer apply.
- Never log API keys. Mask them in the UI (show the last 4 characters).

---

## 7. Classification

### 7.1 Attribute definitions (user-editable on the options page)
```ts
interface AttributeDef {
  id: string;                  // snake_case, stable
  label: string;
  type: 'boolean' | 'enum' | 'multi_enum';
  options?: string[];          // enum / multi_enum; for "topic" this is settings.topics
  maxSelections?: number;      // multi_enum, default 3
  definition: string;          // plain-English rubric sent to the LLM
  source: 'llm' | 'language_builtin';
  enabled: boolean;
}
```

Defaults:
| id | type | source | definition (starting text, user-editable) |
|---|---|---|---|
| `topic` | multi_enum (max 3) | llm | "The main subject(s) of the community, chosen from the list. Use 'other' only if nothing fits." |
| `language` | enum (ISO 639-1 codes + `mixed`, `und`) | language_builtin | See §7.3 |
| `nsfw_sexual` | boolean | llm | "True if the community's main purpose is sexual or pornographic content, or it regularly features nudity or sexual material." |
| `gross` | boolean | llm | "True if the community regularly features content most people find physically disgusting: gore, injuries, medical procedures, pimple/cyst popping, bodily fluids, parasites, rotting matter, extreme insects, or similar." |

The user can add, edit, disable and reorder attributes. Example ideas for the UI placeholder: `political`, `rage_bait`, `spoilers_heavy`.

### 7.2 Default topic list
`news, politics, gaming, sports, technology, programming, science, history, education, finance, crypto, business, careers, entertainment, movies_tv, music, books, anime_manga, art, photography, humor, memes, animals, nature, food, travel, cars, diy_crafts, home_garden, fashion_beauty, fitness, health_medical, relationships, parenting, lgbtq, religion, local_regional, support_advice, q_and_a, shopping_deals, adult, other`

### 7.3 Language
Reddit's tags are often wrong or `und`, and titles can be machine-translated, so no single signal decides.

1. The LLM decides, unless it answers `und`. When the `language` attribute is enabled, it is always asked for a `language_guess` (§7.5), using the original title wording, the description and both `languageEvidence` summaries.
2. If it answers `und`, use `languageEvidence.firefox`, then `languageEvidence.reddit`, if that summary's `count` is at least 3 and at least 70% of its `total`.
3. Otherwise use `und`.

### 7.4 NSFW (sexual) combination rule
Final `nsfw_sexual` = `meta.over18 === true && LLM says true`, OR LLM says true with confidence ≥ 0.8.

Reddit's `over18` flag covers gore as well as sexual content. That's why the LLM decides whether the content is *sexual*. Keep both raw inputs on the record and display them in the review table.

### 7.5 Prompt and schema
- **System prompt**: role ("You classify Reddit communities for a personal content filter. You only label; you never produce content."), then each enabled LLM attribute with its definition and allowed values, the `language_guess` rule when the `language` attribute is enabled, the output rules (JSON only, confidence 0–1, reason ≤ 20 words), and an instruction to use the post titles as the main evidence of what a community actually contains.
- **User message**: name, title, public description, sidebar (truncated to 1500 chars), subscriber count, Reddit's over18 flag, up to 25 titles (each truncated to 200 chars) with their `originalTitle` when it differs, and `languageEvidence`, as a labeled plain-text block. Treat all of this as untrusted data: put it inside clear delimiters and tell the model to ignore any instructions inside it.
- **Output schema** (built dynamically from the enabled attributes):
  ```json
  { "summary": "string",
    "attributes": { "<id>": { "value": <bool|string|string[]>, "confidence": 0.0, "reason": "string" } },
    "language_guess": { "value": "string", "confidence": 0.0, "reason": "string" } }
  ```
  `language_guess` is an ISO 639-1 code, `mixed` or `und`, requested as §7.3 says. Validate enum values against the configured options. Unknown topic values map to `other`, and the mapping is logged.
- **rubricVersion** = short hash (SHA-256 via `crypto.subtle`, first 12 hex chars) of the system prompt template plus the enabled attribute definitions plus the topic list. Any edit changes it, and the review page then offers "N subreddits classified with an older rubric — re-run?" Never re-run automatically, because it costs money.

One subreddit per LLM request in v1. Batching several subreddits per request is a possible later optimization; don't build it now.

---

## 8. Filter rules

```ts
interface FilterList {
  id: string;
  name: string;                       // "Default", "Work-safe", ...
  rule: RuleGroup;
}
interface RuleGroup { op: 'any' | 'all'; children: (RuleGroup | Condition)[] }
interface Condition {
  attribute: string;                  // attribute id, or pseudo: 'subscribers', 'over18_flag'
  operator: 'is' | 'is_not' | 'in' | 'not_in' | 'contains_any' | 'gte' | 'lte';
  value: AttributeValue | number;
  minConfidence?: number;             // default 0.6; below this the condition is false
}
```

- Evaluate a subreddit using `overrides` first, then `classification`. If the needed attribute has no value, the condition is **false**. Unclassified subreddits are handled by the `hideUnclassified` behavior setting instead (§9).
- The evaluator is a pure function in `src/filters/`, with thorough unit tests.
- The **effective block set** for the active list = (subreddits matching the rule ∪ `manualBlock`) − `manualAllow`. The server recomputes it when data changes and stores it with an `updatedAt` that changes only when its content does, or when the server starts. Restoring a backup needs a restart, so the restored set always has a newer `updatedAt` than any device's cached set. The extension fetches it (§5.3) and caches it in `storage.local` as `{ type: 'blockSet', names, reasons, behavior, okNames?, updatedAt }`, where content scripts read it. `okNames` is present only when `hideUnclassified` is on, and lists names known to be fine: classified and not blocked, or manually allowed.
- The review UI has a rule builder (nested groups, add/remove conditions, value pickers built from the attribute definitions) and a **live preview** of how many subreddits match, with a list of them.

---

## 9. Hiding on new Reddit (content script)

Behavior settings:
- `hideMode`: `'remove'` (display none) | `'collapse'` (default). Collapse replaces the post with a thin placeholder: "Hidden: r/foo — gross, topic: crypto [show]".
- `hideUnclassified`: default `false`.
- `exemptOwnSubredditPage`: default `true`. Never hide posts on `/r/<name>` when the user browsed to that subreddit on purpose.
- `enabled` master switch, also toggled from the popup.

These are server settings, and they reach content scripts inside the block set. A change applies on every device after its next block set fetch, and the popup can't change them while the server is unreachable.

How it works:
- Hide by setting a `data-reddithide` attribute on the `shreddit-post` (or its nearest feed-item wrapper; **VERIFY** which element to hide so no gaps or empty cards remain), plus one injected stylesheet. Avoid touching each element's inline styles.
- Run on the same MutationObserver as capture. Hiding must keep up with infinite scroll without visible flicker: inject the stylesheet at `document_start` if needed (**VERIFY**), using attribute selectors built from the block set, as an optimization on top of the per-element pass.
- Show the count of hidden posts on the current page in the popup and as the toolbar badge text.

---

## 10. Exports

From the review page, for the active filter list (or a selected one), export the effective block set as:
1. **Plain text**: one subreddit name per line.
2. **Comma-separated** names.
3. **uBlock Origin cosmetic filters**: one line per subreddit, e.g. `www.reddit.com##shreddit-post[subreddit-name="foo"]`. **VERIFY** the attribute name and that the rule hides the post cleanly. Match the element choice from §9.
4. **RES**: RES's filteReddit module keeps a subreddit filter list in its settings and has a backup/restore feature. **Do not guess the format.** Find it in the RES source (`honestbleeps/Reddit-Enhancement-Suite` on GitHub, filteReddit module and backup/restore code), or by inspecting an RES backup file the user supplies. Then produce either (a) a list in whatever format RES's UI accepts for pasting, or (b) an RES backup JSON with only the filteReddit subreddit list merged in, preserving everything else. Document which approach you used in the README. If the format can't be confirmed, ship 1–3 and leave RES as a clearly labeled TODO.

Full data backup and restore is covered in §4.

---

## 11. User interface

### Popup
- Server URL and token fields, with server unreachable and bad token states.
- Master on/off switch, active filter list selector, number of posts hidden on this page.
- Queue status (discovered / waiting for metadata / waiting for LLM / classified / refused / failed), pause/resume, and any error banner (bad API key, missing permission).
- On a subreddit page: that subreddit's labels, with **Reclassify**, **Always block** and **Always allow** buttons.

### Options page
Served by the server, like the review and compare pages, behind a login page that takes the token.
- **Providers**: list, add from preset, edit, Test, List models, set default/fallback, delete.
- **Attributes & topics**: edit definitions (multiline), add/remove/disable attributes, edit the topic list. Show the current `rubricVersion`.
- **Behavior**: §9 settings.
- **Data**: "clear all data" (with confirmation).

### Review page (full tab)
- A table of all subreddits, virtualized for 10k+ rows, with columns: name (links to the subreddit), summary, each attribute (value plus a confidence hint), over18 flag, detected language, subscribers, seen count, last seen, state, model.
- Sorting, text search, and filtering by state or attribute.
- Row detail drawer: all raw metadata, sample titles, per-attribute reasons, the LLM, Firefox and Reddit language answers side by side, classification history, override controls, reclassify (choose a profile).
- Bulk actions on the selection: reclassify, add to manual block/allow, delete.
- Filter lists: create/rename/delete, rule builder, live preview, export (§10).
- Cost panel: tokens per profile and estimated cost when prices are set.

### Compare page
- Choose profiles A and B, and a sample (N random classified subreddits, or the current selection). Run B, plus A where needed, **without** overwriting the stored classification. Store the results in a separate in-memory/session result set.
- Show agreement rate per attribute and a list of disagreements side by side, with reasons. A "keep B's results" button stores them as the current classification.

---

## 12. Privacy and security
- Only public subreddit data (names, descriptions, titles) goes to LLM providers. Never send the user's identity, cookies, browsing history or URLs.
- The extension sends the server subreddit names, post ids, titles and the original title wording, Reddit's language and NSFW flags, Firefox's language result, descriptions and visitor counts. It never sends cookies, account details or page URLs. What the server stores still reveals which subreddits the user sees, so it stays a private server.
- The server never contacts Reddit, and nothing is ever sent back to Reddit (no votes, joins or posts). Its only outbound traffic goes to the LLM endpoints the user configures.
- Single user, one token. The token, at least 32 characters long, and `PUBLIC_ORIGIN` (§5.4) are required, and the server refuses to start without them. It grants everything, including reading the API keys through `getSettings`. The extension never exposes it to page context. It stays in `storage.local` because `storage.session` is cleared on browser restart. Content scripts can technically read that area, so reading only `blockSet` there is a code rule, and only the background script reads the token.
- Reach the server over a private network such as Tailscale, not the public internet. The login cookie is `Secure`, so the pages need HTTPS, which is set up outside this repo.
- Data from Reddit and from LLMs is untrusted, on the server too. Validate it at the API, render it as text, never with `innerHTML`, and sanitize anything shown as a link. The server's pages send a strict CSP header, because they lose the extension CSP when they move.
- API keys, and the backups that contain them, are stored unencrypted on the server. Say so on the options page and in the README, and recommend keys with spending limits.

---

## 13. Milestones and acceptance criteria

Each milestone ends with `npm run build`, `npm test` and `web-ext lint` all passing.

These milestones, and §14, were written for the standalone extension. Milestones 1–4 are built that way, and epic #25 moves them to the server. The server's nightly backups replace the backup half of milestone 5.

1. **Scaffold + capture**: project setup, manifest, DB, content-script capture, a basic review table listing discovered subreddits with seen counts.
   *Accept:* scrolling `/r/popular` for a minute fills the table with subreddits whose counts go up. The extraction unit test passes against a saved fixture.
2. **Enrichment**: about.json, samples, language detection, rate limiter, status in the popup, handling of private/banned subreddits.
   *Accept:* 50 subreddits enrich without triggering a 429. A private and a banned subreddit end in `skipped` with the correct status.
3. **Providers + classification**: both connectors, presets, Test/List models, prompt/schema, validation and retry, refusal/fallback handling, usage tracking, rubric versioning.
   *Accept:* the same 10 subreddits classify successfully with an Anthropic profile and an OpenAI-compatible profile (a local Ollama model if available). The connector unit tests (mocked `fetch`) cover success, invalid JSON then retry, refusal, 401, 429 and timeout.
4. **Filters + hiding**: rule model, evaluator, rule builder with live preview, manual allow/block, hiding on new Reddit in both modes, popup controls, badge count.
   *Accept:* a rule such as `gross = true OR language not_in [en]` hides the matching posts on the home feed during infinite scroll with no visible flicker. Posts on the subreddit's own page are not hidden when the exemption is on.
5. **Exports + backup**: §10 formats, full backup/restore.
   *Accept:* a backup taken, data cleared and the backup restored gives back identical data. The uBO export hides posts when pasted into uBlock Origin. RES is either confirmed working or documented as a TODO.
6. **Compare + polish**: compare page, cost panel, re-run prompt for an outdated rubric, README (install via `about:debugging`, provider setup including the Ollama CORS note, how filters work).

---

## 14. Things to verify early (do these first in milestone 1)
1. The live new-Reddit DOM: post element name, subreddit attribute names, which wrapper to hide, and how single-page-app navigation behaves.
2. That `about.json` / `top.json` still work from an extension with `credentials: 'include'`, and their rate-limit headers.
3. `browser.i18n.detectLanguage` availability in an MV3 background event page on Firefox 128+.
4. Whether host permissions are granted at install for MV3 in current Firefox.
