# web-knowledge — TODO

---

## IN PROGRESS

*(none yet)*

---

## NOT STARTED

### [TASK 1] Deploy SearXNG
Docker container on dingleberry, port 4243, ARM64 image. Configure engines: Google, Bing, DuckDuckGo, Brave, Wikipedia. Verify JSON API returns results.

---

### [TASK 2] Service Skeleton
Node.js/Express at port 4242. SQLite DB init (cache + library tables). Basic `/search` endpoint wired up. `/health` endpoint.

---

### [TASK 3] Search Pipeline
- Query optimization: Claude Haiku call → refined query string
- SearXNG: search refined query → top 10 URLs + snippets
- Jina: fetch top 5 URLs in parallel → clean Markdown
- Synthesis: Claude Haiku call → clean answer + source list
- Return JSON response

---

### [TASK 4] Caching Layer
- On every cache miss: write answer + sources to `cache` table (24h TTL)
- Also write to `library` table (permanent, no expiry)
- On request: check cache first, return immediately on hit

---

### [TASK 5] systemd Service
`web-knowledge.service` — runs as `claude` user, auto-starts on boot, logs via journalctl. Same pattern as `campaign-companion-api.service`.

---

### [TASK 6] n8n Wiring (Manon integration)
Patch script: add `search_web` toolCode node to Slack AI Agent (`R615lNDRXn7dTkKO`). Also add to Calendar Agent if useful. Test via #manon: "search for X".

---

### [TASK 9] Bind Service to Docker Bridge IP Only
Currently binds to `0.0.0.0:4242` — structurally reachable on all interfaces (LAN exposure dependent on ufw being correct). Fix: bind to `172.18.0.1` only so the service is reachable exclusively from Docker containers, regardless of firewall state. Requires the bridge IP to be stable or dynamically resolved at startup.

---

### [TASK 15] Session Memory — Conversational Context [PRO]

**The concept:** Store raw search content (fetched page content + sources) under a session key so follow-up questions in the same conversation reuse it — no new search, no credits burned.

**Two-stage follow-up logic:**
1. Session key found → attempt re-synthesis from stored content with new question
2. If Haiku determines stored content doesn't contain enough to answer the follow-up → synthesize a refined search term from the follow-up question + prior context → run new search → append new content to session → re-synthesize

Stage 2 is the hard part: the model needs to decide "I can answer from memory" vs "I need new information." Likely a short classification prompt before synthesis.

**Session key strategy — search term as natural key:**
Normalize the search term itself as the session key: `"mulberry blossoms"` → `mulberry_blossoms`. Inherently stable across all clients — no UUID coordination, no per-client session management. Any client asking about the same topic hits the same session bucket.

**Two endpoints:**

`POST /search` — full pipeline, creates/updates session keyed to normalized search term

`POST /followup` — dedicated follow-up route:
1. Takes question + optional topic hint
2. Fuzzy-matches question/hint against existing session keys (small LLM call or embedding similarity)
3. If session found: re-synthesize from stored content
4. If content insufficient: derive new search term from question + prior context → new search → append to session → re-synthesize
5. If no session match: fall through to full `/search`

`/followup` is the pro differentiator — turns a search API into a research API.

**API shape:**
```json
POST /search
{ "query": "mulberry blossoms" }
// session auto-keyed to "mulberry_blossoms"

POST /followup
{ "question": "when exactly do they bloom?", "hint": "mulberry blossoms" }
// hint optional — model derives topic if omitted
```
Session key is implicit — derived from content, not passed by caller.

**Session key sourcing — no universal solution, needs per-client strategy:**
- **n8n (Manon):** toolCode reads `thread_ts` (Slack) or `chatId_threadId` (Telegram) directly from workflow context — invisible to LLM
- **n8n community node:** user provides session key as an optional node parameter, or the node auto-generates one per execution chain
- **Mobile app:** client generates a UUID per conversation, passes it with each call
- **Web browser:** session cookie or localStorage UUID
- **Direct API:** caller provides session key; if omitted, stateless
- Consider a `/session` endpoint: `POST /session` → returns a new session key the client can store and reuse

**Storage:**
- Dev/dingleberry: in-memory Map with TTL (default 2h, configurable via `SESSION_TTL_MINUTES` in `.env`). Dies on restart — fine for conversations.
- Production: Redis. Persistent, shared across instances, native TTL support. Add `REDIS_URL` to `.env`; fall back to in-memory if not set.

**Session content stored:**
- Original query + optimized query
- Raw page content per source (up to 4,000 chars each)
- Source metadata (title, url, snippet)
- Timestamp (for TTL enforcement)

**Pro tier gating:** Session memory only available with a valid API key (Task 10). Free/unauthenticated calls are always stateless.

**Related tasks:** Task 10 (auth), Task 12 (Unkey — per-key session quotas), Task 14 (Redis in prod infra)

---

### [TASK 11] Stripe Meters — Usage-Based Billing
Wire usage tracking into the `/search` request handler (stub already in place). Each successful search fires a Stripe Meter event keyed to the customer's `stripe_customer_id` (looked up via API key). Depends on Task 10 (auth token) being done first. Reference: Stripe Meters + Stripe Billing docs.

---

### [TASK 12] Unkey — API Key Management
Replace simple shared secret (Task 10) with Unkey for production-grade API key issuance, validation, per-key rate limiting, and usage tracking. Users create account → get API key → calls are metered. Unkey integrates with Stripe for billing.

---

### [TASK 13] n8n Community Node
Wrap the public API in an n8n community node. Users add their API key in n8n credentials, use the node like any other. Publish to npm. Depends on public API being stable and deployed. Huge distribution channel.

---

### [TASK 14] Production Deployment
Deploy Docker image to AWS (ECS/Fargate) or Render/Railway for simplicity early on. Add reverse proxy (Caddy or ALB) for TLS. Point domain at it. Depends on Tasks 10–12.

---

### [TASK 8] Swappable LLM Provider
Currently hardcoded to Anthropic. Future: make model + API key configurable via `.env` so users can plug in OpenAI, Gemini, Ollama, etc. for synthesis and query optimization. Design: provider abstraction similar to search/read cascade.

---

### [TASK 7] NocoDB UI (future iteration) — SUPERSEDED by TASK 16
Original plan: deploy NocoDB, connect it directly to the web-knowledge SQLite file as an external source. **Decided against (2026-09-23):** direct connection couples NocoDB to web-knowledge's internal cache schema and risks lock contention — the DB runs in `journal_mode=delete`, not WAL, and web-knowledge writes to it on every request. Went with TASK 16 instead — an n8n workflow syncing `library`/`read_log`/`provider_status` into NocoDB via its API. Left here for the rationale.

---

### [TASK 16] n8n Workflow: Sync web-knowledge Activity to NocoDB
Periodic n8n workflow that reads `library`, `read_log`, and `provider_status` from `knowledge.db` and writes them into NocoDB table(s) via the API, so Eric can browse activity without querying SQLite directly.

- `library` and `read_log` are append-only history — sync as new-rows-only (track by `id` or `created_at` high-water mark).
- `provider_status` is current-state, not a log — 7 small rows, current health/quota per provider. Sync as a periodic overwrite/upsert of the whole table, not an append (Eric: "I understand `provider_status` would be treated a bit differently than the other two").
- **Open question — needs a quick brainstorm before building:** how often should this run? Bounds to weigh: real query volume is low (roughly 1–2 `/search` calls/day in practice as of 2026-09-23, so even hourly is overkill relative to freshness need) vs. how current Eric actually wants the NocoDB view to be vs. not hammering the NocoDB API with mostly-empty syncs. Also decide: one NocoDB table per source table, or something combined?
- **Sequencing:** better to land TASK 17 (provider_status schema changes), TASK 18 (`found_in_cache`), and TASK 19's schema part (tagging columns) *before* building this, so the sync's field mapping is written once against the final schema rather than redone after.

---

### [TASK 17] provider_status: Fix Counters, Add calls_total, Tighten skip_until
Three related fixes to the `provider_status` table/logic in `src/db.js`:

- **Fix `calls_today`/`calls_month`:** `incrementProviderCalls()` currently just increments both forever — there's no daily/monthly rollover despite the names (verified live 2026-09-23: `tavily` shows `calls_today=248, calls_month=248`, identical, because nothing has ever reset). Needs real reset logic (e.g. track a last-reset date; zero `calls_today` on a new day, `calls_month` on a new month).
- **Add `calls_total`:** new column, positioned after `calls_month`. Cumulative, never resets — i.e. exactly the increment-forever behavior `calls_today`/`calls_month` mistakenly have today ("the logic for this is already there"). Seed each existing row's initial value to `MAX(calls_today, calls_month)` — since neither has ever actually reset yet, that current value already *is* the true lifetime count. **Note:** SQLite's `ALTER TABLE ADD COLUMN` always appends the new column at the end of the table — putting `calls_total` positionally after `calls_month` (ahead of `last_failure`/`skip_until`) needs a table rebuild (create new table, copy data across, drop old, rename), not a plain `ALTER TABLE`.
- **Tighten `skip_until` for `exhausted`:** currently 30 days (`MONTHLY_RESET = 30 * 24 * 3600`) after a 429/402. Change to 10 days. The constant is defined separately in both `src/providers/search.js` and `src/providers/read.js` — update both.

---

### [TASK 18] library/read_log: found_in_cache Tally
A cache hit (served from `cache`/`read_cache`) currently leaves zero trace in `library`/`read_log` — those tables only ever see the miss path (confirmed 2026-09-23). Add a `found_in_cache` counter column to both `library` and `read_log`, incremented each time a later request for that same query/URL is served from cache instead of doing a fresh fetch — an important metric since it's the "win rate" for serving repeated searches locally instead of burning a provider call.

- **Design note:** `library`/`read_log` rows are append-only with an autoincrement `id` and nothing unique on the query/URL text, so a cache hit needs a way to know *which* row to credit. Likely approach: store `query_hash`/`url_hash` on each `library`/`read_log` row too (mirroring `cache`/`read_cache`'s key), then on a cache hit run `UPDATE library SET found_in_cache = found_in_cache + 1 WHERE query_hash = ? ORDER BY created_at DESC LIMIT 1` — crediting the most recent row for that query, since that's the fetch currently backing the live cache entry.

---

### [TASK 19] Tagging System for Search + Read (LLM-assigned)
Design and add tagging so entries in `library` and `read_log` can be sorted/browsed by topic on the frontend (feeds TASK 16's NocoDB view). An LLM call assigns tags per search/read — extend to `/read` as well as `/search` per Eric's request.

- `library.tags` already exists in the schema but is dead code today — always written as `[]`, never actually populated. `read_log` has no `tags` column yet and needs one added.
- **Open design questions, not yet resolved:** which LLM call (likely a small Haiku call, same pattern as `optimizeQuery`/`synthesize`, to keep it cheap) and when it fires (every miss, or also cache hits, since those don't produce a fresh row under TASK 18's design); free-form tags chosen by the model vs. a maintained/constrained taxonomy it picks from; how many tags per entry; whether to backfill tags onto the existing ~250 `library` rows or only apply going forward.

---

### [TASK 20] Daily Flush of Old cache/read_cache Entries
Now that a cache hit extends `expires_at` (rolling window — done 2026-09-23, see COMPLETED), a popular entry can live indefinitely, and an entry that's asked once and never again just sits inert in the table forever once `expires_at` lapses (already unserveable — `getCached`/`getCachedRead` filter on `expires_at > now` — but never deleted). Add a daily job that deletes rows from `cache` and `read_cache` where `created_at` is older than a fixed retention window (recommend **30 days** — the DB is tiny at current volume so disk isn't the constraint, and an expired row past that age serves no purpose either way; 15 days works too if preferred, not a load-bearing choice).

- **`created_at` is the fixed source of truth for this** — it is never updated by the rolling-window refresh (`touchCache`/`touchCacheRead` only touch `expires_at`), so it always reflects the entry's true original creation time, unaffected by how many times it's been re-hit since.
- Delete only by `created_at` age — do **not** key this off `expires_at` (that field just gates serving, not retention).
- **Implementation note:** the service already holds an open connection to `knowledge.db` in-process (`better-sqlite3`), so the simplest path is a scheduled task inside `web-knowledge` itself (e.g. a daily interval or lazy check-on-request) rather than routing through n8n or a host cron job — no new infra, no new endpoint needed.

---

## COMPLETED

### [TASK 22] CLI Setup Wizard, API Token Auth (TASK 10, done), Git Packaging — 2026-09-24
Pivoted away from an earlier web-UI-with-login plan (discussed, never built) to a CLI-only design: no web-exposed credential surface at all. `scripts/setup.js` (`npm run setup`) prompts interactively for each provider key (Enter keeps current, shows masked current value) and auto-generates/rotates the `X-WK-Token` API bearer token, writing `.env` (mode 600). Found and fixed a real bug during testing: readline's `question()` silently drops lines that arrive in the same burst as the one it consumes (e.g. pasting several keys at once, or any piped batch input) — replaced with a permanent-listener queued-line reader that can't lose input regardless of timing.

`src/index.js` now requires `X-WK-Token` on `/search` and `/read` (`/health` stays open); fails open with a loud startup warning if unset, matching the service's existing missing-config philosophy. Branding: a green ASCII "K" banner on the CLI wizard (Matrix-style, per Eric — there's no web page left to put a logo on), and `/health` now reports `service: "K — web-knowledge"`.

Turned `~/web-knowledge` into an actual git repo (`git init`, `.gitignore` excluding `.env`/`knowledge.db`, first commit `cf02fc2`) with a real `README.md` for portability — `git clone` → `docker compose run --rm web-knowledge npm run setup` → `docker compose up -d --build` is now the whole deploy story, no host Node needed anywhere.

**Deployed and verified live 2026-09-24:** generated the real token; hardcoded it into the 4 `search_web`/`read_webpage` toolCode nodes on the live Manon Telegram (`43uD84HyBuOanaOb`) and Slack (`R615lNDRXn7dTkKO`) agents *before* rebuilding web-knowledge, to avoid any outage window (backups of both pre-patch workflows at `/mnt/mediaDrive/Claude/n8n-backups/`). Rebuilt (`docker build`, not `compose build` — see TASK 21's buildx note) and confirmed: no/wrong token → 401, correct token → 200, `/health` still unauthenticated.

**Explicitly out of scope for this pass, and known:** the token stops unauthorized *callers*, not a privileged *operator* — this doesn't hide keys from anyone with shell/Docker access to the host (see the banked Docker-isolation discussion in `project_web_knowledge` memory, Eric's Option 2, not started). Rotating the token later means updating both `.env` and all 4 n8n nodes together, since toolCode nodes can't read n8n credentials or (without a full n8n restart) `$env`.

**Two real portability bugs found and fixed the same day, `bc3518c` + `dd83a89`, after Eric asked "would a clone actually work on another server":** the initial "deployed and verified" claim above was tested via a workaround (`docker run -v $(pwd):/app node:22-alpine ...` mounting the whole project dir) rather than the documented `docker compose run --rm web-knowledge npm run setup` command — which hid two bugs: (1) `Dockerfile` never `COPY`'d `scripts/` into the image, so the documented command `MODULE_NOT_FOUND`'d; (2) `.env` was never volume-mounted into the container, so even after fixing (1), the documented command could never see an existing `.env` or persist a new one — env_file injects values into `process.env` at container-start, it doesn't expose the file itself inside the container. Also fixed: `docker-compose.yml` required a pre-existing external `web` Docker network just to start (host-specific, meaningless elsewhere) — replaced with a published port (`4242:4242`, standalone out of the box) plus a gitignored `docker-compose.override.yml` pattern for this host's n8n integration. See [[feedback_verify_via_real_interface]] memory — the lesson: verify via the actual documented interface before calling something shipped, not a convenient-seeming bypass. Re-verified properly this time: isolated scratch test with fake keys first, then re-ran the real command against production itself (preserved the existing token and all keys, end-to-end auth check still passes).

---

### [TASK 21] Rolling 24h Cache Window on Hit — 2026-09-23
A cache hit (`/search` or `/read`) now extends the entry's `expires_at` by another full TTL window (`touchCache`/`touchCacheRead` in `src/db.js`) instead of leaving the original fixed-window expiry in place. `created_at` is deliberately never touched by this — it stays a permanent record of first-cached time, which TASK 20's flush job depends on. Verified live: identical query called twice 4s apart showed `created_at` unchanged, `expires_at` advanced by ~4s on the second (cached) call. Deployed via `docker build` (not `docker compose build` — this host's `buildx` 0.13.1 is older than what Compose v5.5.1's `build` subcommand requires) + `docker compose up -d --force-recreate web-knowledge`.

*(none yet)*
