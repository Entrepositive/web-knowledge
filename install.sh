#!/usr/bin/env bash
# web-knowledge installer / upgrader. Safe to re-run at any time.
#
#   ./install.sh                     interactive: prompts for API keys on first run
#   ./install.sh --non-interactive   no prompts: keys come from environment variables
#   ./install.sh --reconfigure       re-run key setup even if already configured
#   ./install.sh --rotate-token      with --non-interactive: issue a new API token
#
# What it does, in order:
#   1. checks Docker + Docker Compose are installed and usable
#   2. stops the service and moves an older install's files into ./data/
#   3. builds the image
#   4. runs setup (only if not configured yet, or asked to)
#   5. starts the service and waits until /health reports ok
# Exits non-zero, with the reason, if any step fails.
set -euo pipefail

cd "$(dirname "$0")"

NON_INTERACTIVE=0
RECONFIGURE=0
ROTATE=0
for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --reconfigure)     RECONFIGURE=1 ;;
    --rotate-token)    ROTATE=1 ;;
    -h|--help)         sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (see ./install.sh --help)" >&2; exit 2 ;;
  esac
done

KEY_VARS=(ANTHROPIC_API_KEY TAVILY_API_KEY EXA_API_KEY BRAVE_API_KEY SERPER_API_KEY FIRECRAWL_API_KEY ANTHROPIC_MODEL CACHE_TTL_HOURS)
IMAGE=web-knowledge:local

step() { printf '\n==> %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ── 1. Prerequisites ─────────────────────────────────────────────────────────
step "Checking prerequisites"
command -v docker >/dev/null 2>&1 \
  || die "Docker is not installed. Install Docker Engine: https://docs.docker.com/engine/install/"
if ! docker info >/dev/null 2>&1; then
  die "Docker is installed but this user can't talk to it. Either run this script with sudo,
       or add yourself to the docker group (sudo usermod -aG docker \$USER), log out and back in, and retry."
fi
docker compose version >/dev/null 2>&1 \
  || die "The Docker Compose plugin ('docker compose', v2) is missing. Install it: https://docs.docker.com/compose/install/linux/"
echo "Docker $(docker version --format '{{.Server.Version}}'), $(docker compose version --short 2>/dev/null || docker compose version)"

# ── 2. Migrate an older install (files at the repo root instead of ./data) ──
step "Checking for an older install layout"
legacy_env=0
if [ -f .env ] && { [ ! -r .env ] || grep -qE '^(ANTHROPIC_API_KEY|WK_API_TOKEN)=' .env; }; then
  legacy_env=1   # .env holding API keys = pre-data/ layout (a .env with only WK_PORT/WK_BIND is fine)
fi
if [ -e knowledge.db ] || [ -d .env ] || [ "$legacy_env" = 1 ]; then
  echo "Older layout found — stopping the service and moving state into ./data/"
  docker compose down >/dev/null 2>&1 || true
  mkdir -p data
  # Docker turns a missing bind-mounted file into an empty root-owned directory;
  # remove those via a throwaway container (no sudo needed). rmdir only
  # succeeds on an empty directory, so real data can never be lost here.
  for d in knowledge.db .env; do
    if [ -d "$d" ]; then
      rmdir "$d" 2>/dev/null \
        || docker run --rm -v "$PWD:/w" alpine:3 rmdir "/w/$d" \
        || die "./$d is a directory and isn't empty — inspect it and remove it by hand, then re-run."
      echo "  removed stray directory ./$d"
    fi
  done
  if [ -f knowledge.db ]; then
    [ -e data/knowledge.db ] && die "Both ./knowledge.db and ./data/knowledge.db exist — keep one, remove the other, re-run."
    mv knowledge.db data/knowledge.db
    [ -f knowledge.db-journal ] && mv knowledge.db-journal data/knowledge.db-journal
    echo "  moved ./knowledge.db -> ./data/knowledge.db"
  fi
  if [ "$legacy_env" = 1 ]; then
    if [ -e data/config.env ]; then
      echo "  WARNING: ./.env still holds API keys but is no longer used (data/config.env is). Delete ./.env once you've checked it."
    else
      mv .env data/config.env
      echo "  moved ./.env -> ./data/config.env"
    fi
  fi
else
  echo "Nothing to migrate."
fi
mkdir -p data

# ── 3. Build ─────────────────────────────────────────────────────────────────
step "Building the image (first build takes a few minutes)"
if ! docker compose build web-knowledge; then
  # Older buildx plugins make `docker compose build` fail outright
  # ("compose build requires buildx 0.17.0 or later") — the classic builder works.
  echo "docker compose build failed — retrying with the classic builder"
  DOCKER_BUILDKIT=0 docker build -t "$IMAGE" . || die "Image build failed (see output above)."
fi

# ── 4. Configure ─────────────────────────────────────────────────────────────
configured=0
[ -f data/config.env ] && configured=1
ran_setup=0

env_given=0
passthrough=()
for v in "${KEY_VARS[@]}"; do
  if [ -n "${!v:-}" ]; then env_given=1; passthrough+=(-e "$v"); fi
done

if [ "$NON_INTERACTIVE" = 1 ]; then
  if [ "$configured" = 0 ] || [ "$RECONFIGURE" = 1 ] || [ "$ROTATE" = 1 ] || [ "$env_given" = 1 ]; then
    step "Configuring (non-interactive)"
    if [ "$configured" = 0 ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
      die "First install needs ANTHROPIC_API_KEY set in the environment, e.g.
       export ANTHROPIC_API_KEY=sk-ant-...   then re-run ./install.sh --non-interactive"
    fi
    extra=(--non-interactive)
    [ "$ROTATE" = 1 ] && extra+=(--rotate-token)
    docker compose run --rm --no-deps -T ${passthrough[@]+"${passthrough[@]}"} web-knowledge node scripts/setup.js "${extra[@]}" \
      || die "Setup failed (see output above)."
    ran_setup=1
  else
    step "Configuration: keeping existing data/config.env"
  fi
else
  if [ "$configured" = 0 ] || [ "$RECONFIGURE" = 1 ]; then
    step "Configuring"
    [ -t 0 ] || die "Setup needs a terminal to prompt for keys. For unattended installs use:
       ANTHROPIC_API_KEY=... ./install.sh --non-interactive   (see README)"
    docker compose run --rm --no-deps web-knowledge node scripts/setup.js \
      || die "Setup failed (see output above)."
    ran_setup=1
  else
    step "Configuration: keeping existing data/config.env (use --reconfigure to change keys)"
  fi
fi

# ── 5. Start + verify ────────────────────────────────────────────────────────
step "Starting"
docker compose up -d --no-build || die "docker compose up failed (see output above)."
# Config is read at startup — an already-running container must restart to see new keys/token.
if [ "$ran_setup" = 1 ]; then
  docker compose restart web-knowledge || die "Restart after setup failed (see output above)."
fi

step "Waiting for the service to report healthy"
health=""
for _ in $(seq 1 30); do
  cid="$(docker compose ps -q web-knowledge 2>/dev/null || true)"
  if [ -n "$cid" ] && [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" = true ]; then
    if health="$(docker compose exec -T web-knowledge node -e \
        "fetch('http://127.0.0.1:4242/health').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.log(e.message);process.exit(1)})" 2>/dev/null)"; then
      break
    fi
  fi
  health=""
  sleep 2
done

if [ -z "$health" ]; then
  echo "--- last 40 log lines ---"
  docker compose logs --tail 40 web-knowledge || true
  die "The service did not become healthy within 60 seconds. See the log lines above and README 'Troubleshooting'."
fi

published="$(docker compose port web-knowledge 4242 2>/dev/null || true)"
echo "$health"
cat <<EOF

web-knowledge is running.
  URL on this machine:   http://${published:-127.0.0.1:4242}
  Show the API token:    docker compose exec -T web-knowledge npm run -s token
  Logs:                  docker compose logs -f web-knowledge

Every /search and /read request needs the header  X-WK-Token: <token>
To call it from another Docker stack (e.g. n8n), see README "Connecting other containers".
EOF
