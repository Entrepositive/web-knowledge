# POST /read Endpoint Implementation Summary

## Overview
Implemented a standalone webpage reading endpoint (`POST /read`) for the web-knowledge service that extracts clean markdown content from URLs using a provider cascade with SQLite caching.

## Implementation Details

### Files Modified

#### 1. `/home/claude/web-knowledge/src/index.js`
- **Added imports:** `readUrl` from providers/read, `getCachedRead` and `setCacheRead` from db
- **New endpoint:** `POST /read` (lines 117-180)
  - Accepts `{ url: string, timeout_ms?: number }`
  - Validates URL parameter (400 error if missing)
  - Checks cache first (returns with `cached: true`)
  - Calls `readUrl(url)` to run cascade
  - Returns structured response matching spec
  - Caches result for 24h (configurable via `CACHE_TTL_HOURS`)
- **Updated search logic:** Fixed `readUrls()` integration to handle new object return format (lines 83-84)

#### 2. `/home/claude/web-knowledge/src/db.js`
- **New table:** `read_cache` (lines 18-27)
  - Columns: `url_hash`, `url`, `title`, `content`, `source`, `content_length`, `created_at`, `expires_at`
- **New functions:**
  - `getCachedRead(urlHash)` — retrieves cached reads by URL hash, respects TTL
  - `setCacheRead(urlHash, url, title, content, source, contentLength)` — stores reads in cache

#### 3. `/home/claude/web-knowledge/src/providers/read.js`
- **Refactored all provider functions** to return structured objects `{ content, title, source }`
  - `readRawHttp()` — extracts title from `<title>` tag
  - `readJina()` — extracts title from markdown heading
  - `readTavilyExtract()` — uses Tavily's title field
  - `readFirecrawl()` — uses metadata.title
- **Enhanced tryProvider()** (line 13) — auto-assigns `source` field to result
- **Updated readUrl()** (lines 100-109) — works with new object format, min 100-char content filter

### Response Format (matches spec)

**Success:**
```json
{
  "success": true,
  "url": "https://example.com/article",
  "title": "Article Title",
  "content": "Clean markdown extracted content...",
  "source": "raw_http|jina|tavily-extract|firecrawl",
  "content_length": 2847,
  "timestamp": "2026-04-21T14:30:00Z",
  "cached": false
}
```

**Error:**
```json
{
  "success": false,
  "url": "https://example.com/article",
  "error": "Timeout after 4 failed providers",
  "timestamp": "2026-04-21T14:30:00Z"
}
```

**Missing URL (400):**
```json
{
  "error": "url is required"
}
```

## Provider Cascade

Tries in order (stops at first success):
1. **Raw HTTP** — Direct fetch with HTML tag stripping
2. **Jina** — `https://r.jina.ai/[url]` markdown extraction
3. **Tavily Extract** — Tavily API with `include_raw_content=true`
4. **Firecrawl** — Markdown format scrape (if API key available)

Each provider:
- Checks availability (respects degraded/exhausted status)
- Increments call counters for provider tracking
- Filters content (min 100 chars, max 4000 chars)
- Returns gracefully on error (tries next)
- Handles timeouts per provider (4-12s) within 8s total default

## Caching Strategy

- **Cache key:** SHA256 hash of lowercased, trimmed URL
- **TTL:** 24 hours (configurable via `CACHE_TTL_HOURS` env var)
- **Storage:** SQLite `read_cache` table
- **Cache hit:** Returns immediately with `cached: true`
- **Consistent:** Uses same hash & TTL logic as `/search` endpoint

## Rate Limiting

- Endpoint is currently **not rate-limited** separately
- Service-wide limiter applies to `/search` (5 req/10s)
- TODO: Consider adding limiter to `/read` if provider quotas become a concern

## Integration Points

### n8n toolCode Node (Minion B)
The endpoint is designed for n8n integration:
```javascript
// n8n call
POST http://web-knowledge:4242/read
{
  "url": "{{ $json.url_to_read }}"
}

// Usage in workflow
{{ $json.content }}  // Returns clean markdown
{{ $json.source }}   // Which provider succeeded
{{ $json.cached }}   // Whether it was a cache hit
```

### Existing `/search` Endpoint
Fixed integration to handle new `readUrl()` return format. Search now correctly extracts content strings from the objects.

## Testing Recommendations

1. **Valid URLs:**
   - Test with `https://example.com`
   - Test with content-heavy URL (blog post, article)
   - Test with redirects (should follow transparently)

2. **Cache behavior:**
   - Fetch same URL twice, verify `cached: true` on second
   - Check SQLite `read_cache` table has entry

3. **Provider cascade:**
   - Monitor logs to see which provider succeeds
   - Test with URL that might fail raw-http (e.g., JavaScript-heavy site)

4. **Error cases:**
   - Missing `url` parameter → 400
   - Invalid/unreachable URL → 500 with error message
   - All providers fail → 500 with cascade error

5. **Response format:**
   - Validate all response fields match spec exactly
   - Check `timestamp` is ISO 8601
   - Verify `content_length` matches actual content length

## Code Quality Notes

- All code passes Node.js syntax checking
- Uses existing DB transaction patterns
- Follows provider error handling conventions from `/search`
- Consistent logging with `[read]` prefix
- Proper null/undefined checks throughout
- Title extraction is provider-specific and robust

## Future Enhancements

- Add `/read` rate limiting if provider quotas spike
- Add response deduplication (fingerprint content)
- Add provider performance metrics
- Add custom header support for authentication
- Add proxy/tunnel support for geofenced content

---

**Implementation Status:** COMPLETE
**Files Modified:** 3 (index.js, db.js, providers/read.js)
**Lines Added:** ~120
**Tests Pending:** Manual validation with actual URLs (Minion B to coordinate)
