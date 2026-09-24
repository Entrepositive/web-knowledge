# web-knowledge — Planning Document

**Project:** web-knowledge
**Path:** `/home/claude/web-knowledge/`
**Created:** 2026-04-18
**Last updated:** 2026-04-18
**Status:** Phase 0 — Design

---

## What Is This

A standalone web research microservice running on dingleberry. Agents pass a search term; the service returns a clean, synthesized, factual answer — plus stores the result for future reuse. Designed for low latency, zero ongoing cost, and reuse across any project.

**Key design principle:** cascading provider fallbacks for both search and content reading. Tavily first (purpose-built for AI, covers search + content in one call), self-hosted second, freemium API keys third, raw scraping as last resort. When a provider exhausts its quota, the system automatically falls to the next — no downtime, no manual intervention.

**The `.env` is the primary UX for future users.** Every API key lives there. Missing key = provider skipped. Zero-config default works with SearXNG + Jina alone.

---

## Primary Goal

Given a search term like `"mulberry blossoms"`, return:

> *"Mulberry trees bloom in early spring, typically flowering from March to May depending on the species and climate..."*

Not a list of links. Not raw snippets. A confident, synthesized answer with sourcing.

---

## Architecture

```
Agent (n8n toolCode)
  │
  POST /search { query: "..." }
  │
  ▼
web-knowledge service (Node.js / Express, port 4242)
  │
  ├─ 1. SQLite cache check → HIT: return immediately
  │
  └─ MISS:
       │
       ├─ 2. Query optimization (Claude Haiku) → refined query string
       │
       ├─ 3. Search cascade (first available provider)
       │      └─ returns: top URLs + snippets
       │
       ├─ 4. Content reading cascade (top 5 URLs, parallel)
       │      └─ returns: clean Markdown per URL
       │
       ├─ 5. Claude Haiku synthesis → clean answer + source list
       │
       └─ 6. Write to SQLite (cache + library) → return response
```

**Response shape:**
```json
{
  "answer": "Mulberry trees bloom in early spring...",
  "sources": [{ "title": "...", "url": "...", "snippet": "..." }],
  "cached": false,
  "search_provider": "searxng",
  "read_provider": "jina"
}
```

---

## Provider Cascade

### Search Providers (tried in order)

| Priority | Provider | Key | Cost per request | Monthly free | Notes |
|---|---|---|---|---|---|
| 1 | **Tavily Search** | `TAVILY_API_KEY` | 1 credit (basic) | 1,000 credits | `include_raw_content=true` — bundles content reading, skips cascade step 4 |
| 2 | **SearXNG** (self-hosted) | none | Free | Unlimited | Fails only if container is down; triggers content cascade separately |
| 3 | **Brave Search API** | `BRAVE_API_KEY` | Free | 2,000 req | Triggers content cascade separately |
| 4 | **Serper.dev** | `SERPER_API_KEY` | Free | 2,500 req | Triggers content cascade separately |
| 5 | **DuckDuckGo** (scrape) | none | Free | Unlimited | Last resort — fragile but unkillable |

### Content Reading Providers (tried in order — only invoked when search provider doesn't bundle content)

| Priority | Provider | Key | Cost | Monthly free | Notes |
|---|---|---|---|---|---|
| 1 | **Raw HTTP + strip** | none | Free | Unlimited | Zero cost — try first, fail fast in milliseconds |
| 2 | **Jina AI Reader** | none | Free | Soft throttle | `https://r.jina.ai/{url}` — clean Markdown |
| 3 | **Tavily Extract** | `TAVILY_API_KEY` | 1 credit per 5 URLs | Shared with search | Reuses same Tavily key |
| 4 | **Firecrawl** | `FIRECRAWL_API_KEY` | Free | 500 pages/month | |

### Credit Economics (Tavily free tier: 1,000 credits/month)

| Scenario | Credits used | Requests/month |
|---|---|---|
| Tavily primary path (search + content bundled) | 1 credit | 1,000 |
| SearXNG + Tavily Extract (5 URLs) | 1 credit | 1,000 |
| SearXNG + Jina (Tavily unused) | 0 credits | Unlimited |

With caching, most repeated queries cost zero API credits regardless of provider.

### Cascade Logic

**On quota error (HTTP 429 or provider-specific error):**
- Mark provider `exhausted` in SQLite with timestamp
- Skip for remainder of quota period (daily or monthly, per provider)
- State persists across service restarts — no credit wasted on doomed calls

**On network/timeout error:**
- Mark provider `degraded` in SQLite
- Skip for 5 minutes, then retry
- Does not count against quota

**On missing API key:**
- Provider skipped entirely at startup — not attempted at runtime
- Startup log shows active vs skipped providers clearly

**Unkillable last-resort providers:** SearXNG (self-hosted), Raw HTTP strip — no quota, always attempted if reached.

---

## Provider State Tracking (SQLite)

```sql
CREATE TABLE provider_status (
  provider      TEXT PRIMARY KEY,
  type          TEXT,       -- 'search' or 'read'
  status        TEXT,       -- 'active' | 'exhausted' | 'degraded'
  calls_today   INTEGER DEFAULT 0,
  calls_month   INTEGER DEFAULT 0,
  last_failure  INTEGER,    -- unix timestamp
  skip_until    INTEGER     -- unix timestamp (null = not skipped)
);
```

---

## .env — The Key Feature for Future Users

Every API key used by the system lives in one `.env` file. Missing key = provider silently skipped. This makes the project plug-and-play: dump your keys, the cascade configures itself.

`.env.example` is committed to the repo. `.env` is gitignored.

```bash
# ═══════════════════════════════════════════════════
#  web-knowledge — Configuration
#
#  Fill in any keys you have. Missing keys are skipped
#  automatically — the system cascades to the next
#  available provider.
#
#  Cascade order is documented in PLANNING.md.
# ═══════════════════════════════════════════════════

# ── REQUIRED ────────────────────────────────────────
# Claude API (synthesis + query optimization)
# https://console.anthropic.com/
ANTHROPIC_API_KEY=

# ── SEARCH PROVIDERS (priority order) ───────────────

# 1. Tavily — best for AI use cases; covers search + content extraction
#    Free: 1,000 credits/month | https://tavily.com/
TAVILY_API_KEY=

# 2. SearXNG — self-hosted, unlimited, no key needed
#    Set to your instance URL (default: local Docker)
SEARXNG_URL=http://localhost:4243

# 3. Brave Search API
#    Free: 2,000 queries/month | https://brave.com/search/api/
BRAVE_API_KEY=

# 4. Serper.dev — Google results via API
#    Free: 2,500 queries | https://serper.dev/
SERPER_API_KEY=

# 5. DuckDuckGo — scrape-based, no key, last resort
#    Always active (no configuration needed)

# ── CONTENT READING PROVIDERS (priority order) ───────
# (only used when search provider doesn't bundle page content)

# 1. Jina AI Reader — no key needed, always active
#    https://jina.ai/reader/

# 2. Tavily Extract — reuses TAVILY_API_KEY above

# 3. Firecrawl
#    Free: 500 pages/month | https://firecrawl.dev/
FIRECRAWL_API_KEY=

# 4. Raw HTTP + strip — always active, no key needed

# ── CACHE SETTINGS ───────────────────────────────────
CACHE_TTL_HOURS=24
PORT=4242
```

---

## SQLite Schema

```sql
-- Short-term cache (TTL-based)
CREATE TABLE cache (
  query_hash   TEXT PRIMARY KEY,
  query        TEXT,
  answer       TEXT,
  sources      TEXT,        -- JSON array
  created_at   INTEGER,
  expires_at   INTEGER      -- unix timestamp
);

-- Long-term library (permanent)
CREATE TABLE library (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  query           TEXT,
  query_optimized TEXT,
  answer          TEXT,
  sources         TEXT,     -- JSON array
  search_provider TEXT,
  read_provider   TEXT,
  created_at      INTEGER,
  tags            TEXT      -- JSON array (future use)
);

-- Provider quota/health tracking
CREATE TABLE provider_status (
  provider     TEXT PRIMARY KEY,
  type         TEXT,
  status       TEXT DEFAULT 'active',
  calls_today  INTEGER DEFAULT 0,
  calls_month  INTEGER DEFAULT 0,
  last_failure INTEGER,
  skip_until   INTEGER
);
```

---

## n8n Integration

Simple `toolCode` node — no sub-workflow overhead:

```javascript
// toolCode: search_web
const response = await axios.post('http://localhost:4242/search', { query });
return response.data.answer;
```

---

## Latency Budget

| Step | Estimated |
|---|---|
| Cache hit | < 20ms |
| Query optimization (Haiku) | ~300–500ms |
| Search (primary provider) | ~400–800ms |
| Content read × 5 (parallel) | ~1,000–2,500ms |
| Synthesis (Haiku) | ~600–1,200ms |
| **Total (cache miss, happy path)** | **~2.5–5s** |

Cascade fallback adds ~500ms per failed provider. Acceptable given the resilience gained.

---

## Implementation Phases

| Phase | Description | Status |
|---|---|---|
| 1 | Deploy SearXNG Docker (port 4243, ARM64) | ⬜ |
| 2 | Service skeleton: Express, `.env` loader, SQLite init, `/health` | ⬜ |
| 3 | Provider registry: search cascade + content cascade | ⬜ |
| 4 | Search pipeline: query opt → search → read → synthesize | ⬜ |
| 5 | Caching: SQLite cache + library write | ⬜ |
| 6 | systemd service (`web-knowledge.service`) | ⬜ |
| 7 | n8n wiring: `search_web` toolCode on Slack AI Agent | ⬜ |
| 8 | NocoDB UI over library SQLite (future) | ⬜ |

---

## Open Questions

1. Cache TTL: 24h default OK? Some topics (news) may warrant shorter — configurable via `.env`?
2. Jina throttle behaviour under heavy use — monitor in prod, add fallback if needed.
3. DuckDuckGo scrape as last resort — acceptable? No official API, fragile but free.
4. Synthesis model: Haiku default, env flag to upgrade to Sonnet for a specific call?
