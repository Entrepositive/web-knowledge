# Reference for Minion B: n8n Integration

## Endpoint Location & Configuration

**Service:** web-knowledge
**Port:** 4242
**Endpoint:** `POST /read`
**Base URL:** `http://web-knowledge:4242/read` (internal Docker) or `http://localhost:4242/read` (local testing)

## Request Format

```json
{
  "url": "https://example.com/article",
  "timeout_ms": 8000  // optional, default 8000
}
```

## Response Format (Success)

```json
{
  "success": true,
  "url": "https://example.com/article",
  "title": "Article Title Here",
  "content": "# Article Title\n\nClean markdown content extracted...\n\nMore paragraphs...",
  "source": "raw_http",
  "content_length": 2847,
  "timestamp": "2026-04-21T14:30:45.123Z",
  "cached": false
}
```

**Important fields for n8n:**
- `success` — boolean, check before using content
- `content` — **plain markdown string** (this is what you extract from the page)
- `source` — which provider succeeded (useful for debugging/logging)
- `cached` — whether this was a cache hit (useful for analytics)
- `title` — page title if available (may be empty string)

## Response Format (Error)

```json
{
  "success": false,
  "url": "https://example.com/article",
  "error": "Timeout after 4 failed providers",
  "timestamp": "2026-04-21T14:30:45.123Z"
}
```

## n8n toolCode Integration Pattern

### Simple Request (use defaults):
```javascript
const url = "https://example.com/article";
const response = await $helpers.httpRequest({
  method: "POST",
  url: "http://web-knowledge:4242/read",
  json: true,
  body: { url }
});

return response.data;
```

### With Timeout Override:
```javascript
const url = "{{ $json.page_url }}";
const response = await $helpers.httpRequest({
  method: "POST",
  url: "http://web-knowledge:4242/read",
  json: true,
  body: { 
    url,
    timeout_ms: 12000  // up to 15s if needed
  }
});

return response.data;
```

### Handling Response:
```javascript
const result = await $helpers.httpRequest({
  method: "POST",
  url: "http://web-knowledge:4242/read",
  json: true,
  body: { url: "{{ $json.url }}" }
});

const { success, content, source, error, title } = result.data;

if (!success) {
  throw new Error(`Failed to read: ${error}`);
}

return {
  title: title,
  content: content,  // Use this in downstream nodes
  source: source,
  url: "{{ $json.url }}"
};
```

## Expected Provider Outputs

Each response will include one of these sources:

| Source | Format | When Used |
|--------|--------|-----------|
| `raw_http` | HTML tags stripped | Most sites, fastest |
| `jina` | Markdown from r.jina.ai | When raw-http doesn't work well |
| `tavily-extract` | Tavily API raw_content | When Tavily key is available |
| `firecrawl` | Firecrawl markdown | Last resort, when key available |

## Cache Behavior

- **First call:** Fetches content, returns with `cached: false`
- **Second call (same URL):** Returns cached copy within 5ms, `cached: true`
- **Cache duration:** 24 hours (can be configured via service env var)
- **Cache key:** SHA256 hash of lowercased URL

Example workflow:
```javascript
// Call 1 at 14:30 UTC
POST /read { url: "https://example.com" }
// Returns: { success: true, content: "...", cached: false, ... }

// Call 2 at 14:31 UTC (same URL)
POST /read { url: "https://example.com" }
// Returns: { success: true, content: "...", cached: true, ... }
// (identical content, no API calls made)

// Call 3 at 14:31 UTC+24h (next day)
POST /read { url: "https://example.com" }
// Returns: { success: true, content: "... (maybe newer)", cached: false, ... }
// (cache expired, refetched)
```

## Error Handling in n8n

All errors return `success: false` with an `error` field:

```javascript
const result = await callEndpoint();

// Option 1: Check success flag
if (!result.success) {
  // Handle error — log, retry, or skip
  console.error("Read failed:", result.error);
  return { error: result.error };
}

// Option 2: Use conditional node in n8n
// Add a switch/IF node after HTTP Request:
// If input.success == true → continue to synthesis
// If input.success == false → log error, set default content
```

## Rate Limiting & Quotas

- **No rate limit on `/read` itself** — call as often as needed
- **Service-wide limit:** 5 requests per 10 seconds (applies to `/search`, not `/read`)
- **Provider quotas:** Handled automatically
  - Jina: free, no quota
  - Raw HTTP: depends on target site
  - Tavily Extract: quota in TAVILY_API_KEY account (fallback if key missing)
  - Firecrawl: quota in FIRECRAWL_API_KEY account (fallback if key missing)
- **Degraded providers:** Auto-skip for 5 minutes on error, 30 days if quota hit

## Testing with Example URLs

Quick test URLs to validate the endpoint:

1. **Simple HTML:**
   - `https://example.com` → short content, title "Example Domain"

2. **Wikipedia (good source):**
   - `https://en.wikipedia.org/wiki/Web_scraping` → long content, structured markdown

3. **Blog/Article:**
   - `https://www.paulgraham.com/articles.html` → good text extraction

4. **JavaScript-heavy (tests cascade):**
   - `https://news.ycombinator.com/` → may need Jina if raw-http struggles

## Debugging Tips

1. **Check source field** — tells you which provider succeeded
   - If it's `raw_http`, the site is straightforward HTML
   - If it's `jina`, means raw-http didn't work well
   - If it's `tavily-extract` or `firecrawl`, means cascade went deep

2. **Monitor response timestamps** — should be instant if cached
   - `cached: true` → microseconds (DB lookup)
   - `cached: false` → 2-5 seconds (API calls)

3. **Log content_length** — sanity check on extraction
   - Too short (< 500 chars) → might be auto-homepage or error page
   - Good (500-10000 chars) → solid extraction
   - Max (4000 chars) → truncated (enough for most uses)

4. **Check title field** — useful for verification
   - If title is empty, might be a dynamic/framework site
   - If title matches expected article title, good extraction

## Integration with Other Workflows

### Example: Auto-summarize articles
```
1. Get URL from user input
2. Call /read endpoint
3. If success, send content to LLM for summary
4. Return summary to user
```

### Example: Knowledge base ingestion
```
1. Loop over list of URLs
2. Call /read on each
3. Store content + title + source in KB
4. Log any failures for manual review
```

### Example: Link preview generation
```
1. Extract URL from Telegram message
2. Call /read endpoint
3. Extract first 300 chars of content + title
4. Format as preview block
5. Send back to Telegram
```

---

**Implementation Status:** Complete, tested for syntax
**Next Steps for Minion B:**
1. Build n8n toolCode node or HTTP Request node to call `/read`
2. Test with 3-5 sample URLs
3. Coordinate end-to-end test (your n8n → web-knowledge service)
4. Verify response format matches expectations
5. Set up error handling & logging
