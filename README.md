# K — web-knowledge

A small, self-contained research microservice: ask it a question, get back a
synthesized, sourced answer; give it a URL, get back clean page text. It
falls through a cascade of providers (Tavily, a self-hosted SearXNG, Exa,
Brave, Serper, DuckDuckGo for search; raw HTTP, Jina, Tavily Extract,
Firecrawl for reading pages) so no single provider's downtime or rate limit
takes it down, and caches aggressively so repeat questions cost nothing.

## Quickstart

```bash
git clone <this repo> web-knowledge && cd web-knowledge
docker compose run --rm web-knowledge npm run setup   # interactive — paste in your provider keys
docker compose up -d --build
curl -s http://localhost:4242/health
```

`setup` is the only configuration step. It's a CLI wizard, not a web page —
there is no login UI and nothing web-exposed for entering credentials. It
writes a `.env` (mode 600, gitignored) and auto-generates an API token,
which it prints once at the end. Re-run `npm run setup` any time to change a
key or rotate the token; it shows your current values (masked) and Enter
keeps them as-is.

## Using it

Every request to `/search` and `/read` must include the token from setup:

```bash
curl -X POST http://localhost:4242/search \
  -H "Content-Type: application/json" \
  -H "X-WK-Token: <token from setup>" \
  -d '{"query":"when do cherry blossoms peak in Tokyo"}'

curl -X POST http://localhost:4242/read \
  -H "Content-Type: application/json" \
  -H "X-WK-Token: <token from setup>" \
  -d '{"url":"https://example.com/article"}'
```

`/health` needs no token and returns `{"status":"ok"}`.

Only `ANTHROPIC_API_KEY` is required (used for query optimization and answer
synthesis). Every other provider key is optional — skip any of them in setup
and that provider is silently skipped in the cascade. SearXNG needs no key at
all; it's a second container in `docker-compose.yml` and runs automatically.

## What's *not* covered

The API token stops other people/services from spending your provider quota
through this instance. It does **not** hide the keys from anyone with shell
or Docker access to the host it's running on — Docker group membership is
effectively root-equivalent, so a real "even the operator's tooling can't
see this" boundary needs the keys to live on genuinely separate
infrastructure, which this project doesn't attempt. Treat `.env` and
`knowledge.db` (which holds search/read history) as sensitive files on
whatever host you run this on.

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | liveness check |
| `POST /search` | `X-WK-Token` | `{query}` → synthesized answer + sources |
| `POST /read` | `X-WK-Token` | `{url, timeout_ms?}` → cleaned page text |
