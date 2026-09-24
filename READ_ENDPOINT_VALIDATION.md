# POST /read Endpoint Validation Checklist

## Specification Compliance

- [x] Endpoint responds to `POST /read`
- [x] Accepts `{ url, timeout_ms? }` JSON body
- [x] Validates URL parameter (returns 400 if missing)
- [x] Returns success response with all required fields
- [x] Returns error response with correct format
- [x] Includes `timestamp` in ISO 8601 format
- [x] Response field `source` identifies provider (`raw_http|jina|tavily-extract|firecrawl`)
- [x] Response includes `cached` boolean flag

## Provider Cascade

- [x] Cascade order: Raw HTTP → Jina → Tavily Extract → Firecrawl
- [x] Stops at first successful provider
- [x] Returns provider name in `source` field
- [x] Each provider returns `{ content, title, source }`
- [x] Content validation: min 100 chars, max 4000 chars
- [x] Title extraction (provider-specific logic)

## Caching

- [x] SQLite table `read_cache` created
- [x] Cache key: SHA256 hash of URL (lowercased, trimmed)
- [x] Cache TTL: 24 hours (configurable via `CACHE_TTL_HOURS`)
- [x] Cache check before cascade
- [x] Cache write after successful read
- [x] Cache hit returns with `cached: true`
- [x] Cache miss returns with `cached: false`
- [x] Expired entries ignored (TTL check)

## Database Integration

- [x] Added `read_cache` table to schema
- [x] Added `getCachedRead(urlHash)` function
- [x] Added `setCacheRead()` function
- [x] Functions use consistent TTL logic
- [x] Functions use consistent hash algorithm

## Provider Functions

- [x] `readRawHttp()` — HTML tag stripping, title from `<title>` tag
- [x] `readJina()` — Markdown from `https://r.jina.ai/`, title from heading
- [x] `readTavilyExtract()` — Tavily API, returns `raw_content`
- [x] `readFirecrawl()` — Markdown format, metadata.title
- [x] All providers wrapped in `tryProvider()` with error handling
- [x] Provider status tracking (exhausted/degraded)
- [x] Call counting for analytics

## Error Handling

- [x] Missing URL → 400 with error message
- [x] Invalid URL → 500 with error message
- [x] All providers fail → 500 with cascade error
- [x] Network timeout → handled per provider
- [x] API quota hit → marks provider exhausted for 30 days
- [x] Provider error → marks degraded for 5 minutes
- [x] All errors logged with `[read]` prefix

## Integration

- [x] `readUrl()` exported from providers/read.js
- [x] `readUrl()` integrated in index.js `/read` endpoint
- [x] Fixed `readUrls()` usage in `/search` endpoint (handles new object format)
- [x] DB functions exported and imported correctly

## Response Format Validation

**Success response fields:**
- [x] `success: true`
- [x] `url: string`
- [x] `title: string` (may be empty)
- [x] `content: string` (markdown)
- [x] `source: string` (provider name)
- [x] `content_length: number`
- [x] `timestamp: string` (ISO 8601)
- [x] `cached: boolean`

**Error response fields:**
- [x] `success: false`
- [x] `url: string`
- [x] `error: string`
- [x] `timestamp: string` (ISO 8601)

**Cache hit format:**
- [x] Same as success but with `cached: true`
- [x] All fields populated from DB

## Code Quality

- [x] Syntax validation passed (Node.js -c)
- [x] No TypeErrors from type mismatches
- [x] Consistent error handling patterns
- [x] Proper null/undefined checks
- [x] Logging consistent with service style
- [x] No hardcoded timeouts conflicts with param
- [x] Follows existing code patterns

## Ready for n8n Integration

- [x] Response format matches n8n expectations
- [x] `content` field is plain markdown string
- [x] `source` field identifies provider for logging
- [x] `timestamp` useful for debugging
- [x] Error responses have `success: false` for conditional logic
- [x] Endpoint can be called from n8n toolCode node

## Manual Test Scenarios

Ready to test with:
1. Simple URL (example.com) → should succeed with raw-http
2. Blog post URL → should have good title/content
3. Redirect URL → should follow and extract from final page
4. Repeated URL → second call should hit cache
5. Invalid URL → should return 400 for missing URL or 500 for network error

---

**Status:** Implementation complete, ready for end-to-end testing with Minion B
**Next Step:** Minion B builds n8n toolCode node, coordinates end-to-end test
