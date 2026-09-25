# K — web-knowledge

A small, self-contained research microservice. Ask it a question and it
returns a synthesized answer with sources. Give it a URL and it returns clean
page text. It works through a cascade of providers, so no single provider's
outage or rate limit takes it down:

- **Search:** Tavily, a bundled self-hosted SearXNG, Exa, Brave, Serper, DuckDuckGo
- **Reading pages:** raw HTTP, Jina Reader, Tavily Extract, Firecrawl

It also caches results, so repeat questions cost nothing.

Everything runs in Docker: the service plus its SearXNG sidecar. Nothing is
installed on the host besides this folder.

---

## Requirements

| Need | Check with | Notes |
|---|---|---|
| Linux or macOS host, x86-64 or ARM64 | `uname -sm` | Tested on Debian 13 (ARM64, Raspberry Pi 4). |
| Docker Engine 20.10 or newer | `docker version` | [Install Docker](https://docs.docker.com/engine/install/) |
| Docker Compose v2 (`docker compose`, with a space) | `docker compose version` | The old `docker-compose` v1 is not supported. |
| Permission to use Docker | `docker info` | If this fails with "permission denied", run the commands with `sudo`, or add yourself to the `docker` group (`sudo usermod -aG docker $USER`, then log out and back in). |
| `git` | `git --version` | Only needed to download and update the code. |
| An Anthropic API key | — | Required. [console.anthropic.com](https://console.anthropic.com/) |
| Any other provider keys | — | Optional. See [Configuration](#configuration). |
| Free host port 4242 | — | Configurable, see [Changing the port](#changing-the-port-or-exposing-it-to-your-network). |

The repository is **private**. Cloning it needs a GitHub account that has
access to it: HTTPS with a personal access token, or SSH with a key added to
GitHub.

The first build downloads roughly 300 MB of images and takes 2–10 minutes,
depending on the machine.

---

## Install

Choose any directory you like; the commands below create `web-knowledge/`
inside it. Everything the service stores stays inside that folder.

```bash
git clone https://github.com/Entrepositive/web-knowledge.git
cd web-knowledge
./install.sh
```

`install.sh` checks the requirements, builds the image, asks for your API
keys, starts the service, and waits until it reports healthy. It ends with a
summary like this:

```
{"status":"ok","service":"K — web-knowledge"}

web-knowledge is running.
  URL on this machine:   http://127.0.0.1:4242
  Show the API token:    docker compose exec -T web-knowledge npm run -s token
  ...
```

If it prints `ERROR:` instead, the message says what went wrong and it exits
with a non-zero status. See [Troubleshooting](#troubleshooting).

During setup, each key prompt accepts a pasted value. Press Enter to skip an
optional provider. At the end, setup prints the **API token** that callers
must send. You can print it again at any time, so you don't need to copy it
now.

### Unattended install (scripts, CI, coding agents)

To install with no prompts, pass the keys as environment variables:

```bash
git clone https://github.com/Entrepositive/web-knowledge.git
cd web-knowledge
export ANTHROPIC_API_KEY='sk-ant-...'      # required
export TAVILY_API_KEY='tvly-...'           # optional — set only the ones you have:
                                           # EXA_API_KEY BRAVE_API_KEY SERPER_API_KEY FIRECRAWL_API_KEY
./install.sh --non-interactive
TOKEN="$(docker compose exec -T web-knowledge npm run -s token)"
```

- `install.sh --non-interactive` exits `0` only when the service is running
  and `/health` returns `{"status":"ok"}`. Otherwise it exits non-zero, and
  the last lines of output explain why.
- The keys are read from the environment and never appear on a command line.
- The API token is generated automatically. `npm run -s token` prints only
  the token, so it can be captured into a variable as shown above.
- Re-running with new variables set updates just those keys and keeps
  everything else.

### Install without the script

These are the same steps `install.sh` performs, if you'd rather run them
yourself:

```bash
mkdir -p data
docker compose build            # if this fails with "requires buildx 0.17.0 or later", run instead:
                                #   DOCKER_BUILDKIT=0 docker build -t web-knowledge:local .
docker compose run --rm web-knowledge npm run setup     # prompts for keys, prints the token
docker compose up -d
docker compose ps               # web-knowledge should show "(healthy)" within ~30 s
```

You can also write `data/config.env` by hand from
[`config.example.env`](config.example.env) and skip the setup step.

---

## Checking it works

```bash
curl -sS http://127.0.0.1:4242/health
```

| Response | Meaning |
|---|---|
| `{"status":"ok",...}` | Healthy. |
| `{"status":"unconfigured","missing":[...]}` | Running, but setup hasn't been done or a required key is missing. Run `docker compose run --rm web-knowledge npm run setup`, then `docker compose restart web-knowledge`. |
| `Connection refused`, `Empty reply from server`, or no output at all | **Not running.** Check `docker compose ps` and `docker compose logs web-knowledge`. An empty response never means healthy. |

If `curl` isn't installed, use `docker compose ps`. A working service shows
`Up ... (healthy)`.

Then try a real request:

```bash
TOKEN="$(docker compose exec -T web-knowledge npm run -s token)"

curl -sS -X POST http://127.0.0.1:4242/read \
  -H "Content-Type: application/json" -H "X-WK-Token: $TOKEN" \
  -d '{"url":"https://example.com"}'

curl -sS -X POST http://127.0.0.1:4242/search \
  -H "Content-Type: application/json" -H "X-WK-Token: $TOKEN" \
  -d '{"query":"when do cherry blossoms peak in Tokyo"}'
```

---

## API

| Endpoint | Auth | Body | Returns |
|---|---|---|---|
| `GET /health` | none | — | `200 {"status":"ok"}`, or `503 {"status":"unconfigured",...}` |
| `POST /search` | `X-WK-Token` | `{"query": "..."}` | `{answer, sources[], cached, search_provider, read_provider}` |
| `POST /read` | `X-WK-Token` | `{"url": "...", "timeout_ms"?: 8000}` | `{success, url, title, content, source, content_length, cached}` |

These errors can come back from any endpoint that needs the token:

| Status | Meaning |
|---|---|
| `401` | Missing or wrong `X-WK-Token`. |
| `503` | Not configured yet. |
| `429` | Too many requests: `/search` allows 5 per 10 seconds. |

---

## Connecting other containers

This matters when you want another Docker stack on the same host (n8n, for
example) to call the service. From inside another container, `127.0.0.1` means
*that* container, not the host. So the other container reaches web-knowledge
over a shared Docker network, by name:

1. Find the network the other container is on:
   ```bash
   docker ps --format '{{.Names}}'                      # find the container's name, e.g. n8n
   docker inspect n8n --format '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}'
   ```
2. Create the override file and put that network name where it says `CHANGE_ME`:
   ```bash
   cp docker-compose.override.example.yml docker-compose.override.yml
   ```
3. Apply the change: `docker compose up -d`
4. From the other container, call **`http://web-knowledge:4242`** with the
   `X-WK-Token` header. To test this from inside it:
   ```bash
   docker exec n8n wget -qO- http://web-knowledge:4242/health
   ```

`docker-compose.override.yml` is specific to your host and is not tracked by
git. Docker Compose picks it up automatically.

---

## Configuration

All state lives in `./data/`:

| File | What it is |
|---|---|
| `data/config.env` | API keys and the API token (mode 600). Written by setup. |
| `data/knowledge.db` | SQLite cache and history of searches and page reads. |

Treat the whole `data/` folder as sensitive, and back it up if the history
matters to you.

- **Change keys:** `docker compose run --rm web-knowledge npm run setup`,
  then `docker compose restart web-knowledge`.
- **Rotate the API token:** the same setup command (answer `y` when it asks
  to rotate), or
  `./install.sh --non-interactive --rotate-token`. Anything that uses the old
  token stops working until you give it the new one.
- **Print the API token:** `docker compose exec -T web-knowledge npm run -s token`
  (if the service is stopped, use `docker compose run --rm -T web-knowledge npm run -s token`)

Only `ANTHROPIC_API_KEY` is required. Any other provider without a key is
skipped. SearXNG, DuckDuckGo, raw HTTP and Jina need no keys, so search and
page reading still work with just the Anthropic key. Every setting is
documented in [`config.example.env`](config.example.env).

### Changing the port or exposing it to your network

By default the service is published on `127.0.0.1:4242`, which is reachable
from this machine only. To change that, create a file named `.env` next to
`docker-compose.yml`. This file holds only these settings, never API keys:

```bash
WK_PORT=4300        # use a different host port
WK_BIND=0.0.0.0     # accept connections from other machines on your network
```

Then run `docker compose up -d`. Before using `WK_BIND=0.0.0.0`, remember
that anyone who can reach the port and has the token can spend your provider
quota.

---

## Updating

```bash
cd web-knowledge
git pull
./install.sh            # rebuilds, keeps your config and data, restarts, verifies health
```

Installs made before this layout existed kept `.env` and `knowledge.db` in
the repo root. `install.sh` detects that and moves them into `data/`
automatically, including a `knowledge.db` that Docker wrongly created as a
directory.

---

## Uninstalling

```bash
cd web-knowledge
docker compose down --rmi local     # stop and remove containers, network and the built image
cd .. && rm -rf web-knowledge       # deletes your config and history too
```

If `rm` reports "permission denied" inside `data/`, the folder was created by
Docker as root. Use `sudo rm -rf web-knowledge`.

---

## Troubleshooting

Start with `docker compose ps` and `docker compose logs --tail 50 web-knowledge`.

| Symptom | Cause | Fix |
|---|---|---|
| `SqliteError: unable to open database file` / `SQLITE_CANTOPEN`, container restarting | An install from before the `data/` layout, where Docker created `knowledge.db` as a directory. | `git pull && ./install.sh` migrates it. |
| `compose build requires buildx 0.17.0 or later` | Your buildx plugin is older than your Compose. | `install.sh` falls back automatically. By hand: `DOCKER_BUILDKIT=0 docker build -t web-knowledge:local .` |
| `Bind for 127.0.0.1:4242 failed: port is already allocated` | Something else is using port 4242. | Set `WK_PORT` (see [Changing the port](#changing-the-port-or-exposing-it-to-your-network)). |
| `permission denied while trying to connect to the Docker daemon socket` | Your user can't use Docker. | Use `sudo`, or join the `docker` group (see [Requirements](#requirements)). |
| `/health` says `unconfigured` | Setup hasn't run, or `ANTHROPIC_API_KEY` is empty. | `docker compose run --rm web-knowledge npm run setup`, then `docker compose restart web-knowledge` |
| `401` from `/search` or `/read` | Wrong or missing `X-WK-Token`. | Print the current token (`npm run -s token`, see above) and update the caller. |
| `/search` returns 500 mentioning `authentication_error` | The Anthropic key is wrong or revoked. | Re-run setup with a valid key. |
| Another container can't reach `http://web-knowledge:4242` | They don't share a Docker network. | See [Connecting other containers](#connecting-other-containers). |

---

## Security notes

The API token stops other people and services from spending your provider
quota through this instance. It does **not** hide the keys from anyone with
shell or Docker access to the host. Docker group membership is effectively
root-equivalent. Treat `data/` as sensitive on whatever host you run this on.
