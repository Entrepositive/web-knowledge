# /read Endpoint Specification

**Purpose:** Standalone webpage reading tool. Takes a URL, returns clean extracted content using the same cascade as search_web.

---

## API Contract

### Request

```
POST /read
Content-Type: application/json

{
  "url": "https://example.com/article",
  "timeout_ms": 10000  // optional, default 8000
}
```

### Response (Success)

```json
{
  "success": true,
  "url": "https://example.com/article",
  "title": "Article Title",
  "content": "Clean markdown extracted content...",
  "source": "raw_http|jina|tavily|firecrawl",
  "content_length": 2847,
  "timestamp": "2026-04-21T14:30:00Z",
  "cached": false
}
```

### Response (Error)

```json
{
  "success": false,
  "url": "https://example.com/article",
  "error": "Timeout after 3 failed providers",
  "timestamp": "2026-04-21T14:30:00Z"
}
```

---

## Content Read Cascade

1. **Raw HTTP** — direct fetch + clean HTML/markdown
2. **Jina** — `https://r.jina.ai/[url]` (markdown extract)
3. **Tavily Extract** — use existing Tavily API (include `include_raw_content=true`)
4. **Firecrawl** — fallback (if available)

Stop at first success. Return the `source` that succeeded.

---

## Implementation Notes

- Reuse existing provider functions from `/search` pipeline
- Cache result in SQLite `cache` table (24h TTL)
- Rate limiting: included in existing 5 req/10s service-wide limit
- Return markdown, not raw HTML
- Handle redirects transparently
- Timeout per provider: 4–5 seconds, total: 10 seconds default

---

## Integration Point (n8n)

n8n toolCode node will call:
```
POST http://web-knowledge:4242/read
{
  "url": "{{ $json.url_to_read }}"
}
```

Response used directly: `{{ $json.content }}`

Minion B will build the n8n node to match this interface.

---

## Success Criteria

- [ ] Endpoint responds to POST /read
- [ ] Cascade works (at least Raw HTTP or Jina succeeds)
- [ ] Returns clean markdown
- [ ] Caches result
- [ ] Integrates with n8n toolCode node (Minion B)
- [ ] Tested with 3 sample URLs
