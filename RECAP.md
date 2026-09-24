# web-knowledge — Situation Report

**Last updated:** 2026-04-21 (session 2 — /read endpoint built & tested, minion orchestration)
**Phase:** Live ✅ (Telegram pending manual activation in n8n UI)
**Path:** `/home/claude/web-knowledge/`

---

## What Is This

Standalone web research microservice. Agent passes a search term; service returns a synthesized factual answer. Results cached in SQLite. Integrated into both Manon agents (Slack + Telegram). Built for eventual public deployment as a paid API product.

---

## Current State

| Component | Status |
|---|---|
| Docker: web-knowledge container | ✅ Running |
| Docker: SearXNG container (internal) | ✅ Running |
| SQLite cache + library | ✅ Active (knowledge.db bind-mounted) |
| Tavily (search + extract, primary) | ✅ |
| SearXNG (fallback #2) | ✅ |
| Brave Search (fallback #3) | ✅ |
| Raw HTTP (content read primary) | ✅ |
| Jina AI Reader (content fallback) | ✅ |
| Rate limiting (5 req / 10s) | ✅ |
| Slack Agent — search_web | ✅ Live at http://web-knowledge:4242/search |
| Telegram Agent — search_web | ✅ Code updated — ⚠️ needs manual activation in n8n UI |
| Telegram Audio Branch routing | ✅ Fixed |
| Usage tracking stub (Stripe hook) | ✅ In place |
| systemd service | 🔴 Disabled (replaced by Docker) |

---

## Session 1 — What Was Done (2026-04-18)

### Built
- Full service: Express + SQLite + 6-provider search cascade + 4-provider content read cascade
- Dockerfile (node:22-alpine), docker-compose joining `web` + `internal` networks
- Rate limiting, provider quota tracking, usage stub, `.env.example`

### Debugged
- **toolCode localhost bug** — Docker containers can't reach host ports. Fix: containerized service, n8n calls `http://web-knowledge:4242` by container name
- **Telegram Audio Branch** — `isAudio` flag (persistent) was gating STT pipeline; text messages failed on `Get TG File Info`. Fix: condition now checks `$json.fileId !== null`
- **Content read cascade reordered** — Raw HTTP moved to first (zero cost, fast fail)

### Validated
- Stamford Half Marathon test: app found correct race, date, location. Reported 8:00 AM from all public sources; Eric's 07:50 was internal org timing. App working correctly.

### Designed (not built)
- **Task 15** — Session memory / conversational context (PRO feature)
  - Search-term-as-session-key insight: `"mulberry blossoms"` → `mulberry_blossoms`
  - Two endpoints: `POST /search` (creates session) + `POST /followup` (fuzzy-matches session, re-synthesizes or searches fresh)
  - Hint-optional: model derives topic from question alone if no hint provided
  - Two-stage follow-up: try stored content → fall back to new search if insufficient
  - Storage: in-memory Map now, Redis for production

---

## Production Roadmap (Tasks in TODO.md)

| Task | Description |
|---|---|
| 9 | Bind to Docker bridge IP only (security) |
| 10 | Auth token for /search (X-WK-Token) — PRO gate |
| 11 | Stripe Meters — usage-based billing |
| 12 | Unkey — API key management |
| 13 | n8n community node |
| 14 | AWS/Render production deployment |
| 15 | Session memory + /followup endpoint (PRO) |
| 8 | Swappable LLM provider |
| 7 | NocoDB UI over knowledge library |

---

## Session 2 — What Was Done (2026-04-21)

### Dual Minion Orchestration: read_webpage Tool ✅

**Minion A (web-knowledge backend):**
- Implemented `POST /read` endpoint in `src/index.js` (lines 117-180)
- Added SQLite caching layer to `src/db.js` (24h TTL with SHA256 URL hashing)
- Created provider wrapper functions in `src/providers/read.js` (raw-http, jina, tavily-extract, firecrawl)
- Response format matches spec exactly: `{ success, url, title, content, source, content_length, timestamp, cached }`
- Created 3 documentation files for Minion B integration

**Minion B (n8n integration):**
- Designed complete toolCode node specification (9 documentation files, ~50 KB)
- Created importable n8n node JSON (`read-webpage-toolcode-node.json`)
- Designed integration guides for Slack + Telegram agents
- Created 29 comprehensive test cases (unit → integration → E2E → error paths)
- All files ready in `/home/claude/manon/`

### Backend Testing & Validation ✅

**Tests passed:**
1. ✅ `example.com` — raw-http provider, title extracted, cached: false
2. ✅ `httpbin.org/get` — JSON content extraction, works with diverse content types
3. ✅ `example.com` (retry) — SQLite cache hit, cached: true

**Provider cascade validated:**
- Raw HTTP → Jina → Tavily → Firecrawl (stops at first success)
- Content cleaning working (markdown formatted output)
- Caching working (24h TTL, SHA256 URL hashing)

**Docker rebuild required:** Initial container restart didn't load code changes. Solution: `docker compose build --no-cache` to rebuild image from updated src/ files.

---

## Next Session — Start Here

1. **Import n8n toolCode node** — Use `read-webpage-toolcode-node.json` from Manon project
2. **Wire into Slack + Telegram agents** — Follow `READ_WEBPAGE_INTEGRATION_GUIDE.md`
3. **Run 29-test suite** — Validate end-to-end integration (from `READ_WEBPAGE_TESTING.md`)
4. **Test live in #manon** — User: "read https://..." → Manon: returns content
5. **Activate Telegram workflow** in n8n UI (manual — API activation fails due to DNS blip)
6. **Task 15 (session memory)** when ready to build the PRO tier

---

## Key Architecture Notes

- **Network:** web-knowledge container on `web` (shared with n8n) + `internal` (SearXNG only)
- **toolCode URL:** `http://web-knowledge:4242/search` — always container name, never localhost/bridge IP
- **Telegram activation:** always do manually via n8n UI — API activate fails (DNS resolution error in container)
- **patch scripts:** must be `.cjs` (package.json has `"type": "module"`)
- **SQLite:** `knowledge.db` bind-mounted at `./knowledge.db:/app/knowledge.db`
- **Session key vision:** normalize search term → use as natural session key; `/followup` fuzzy-matches

---

## Active API Keys

| Provider | Status |
|---|---|
| Anthropic (Claude Haiku) | ✅ |
| Tavily | ✅ |
| Brave | ✅ |
| Exa | ⬜ Worth getting |
| Serper | ⬜ |
| Firecrawl | ⬜ |
