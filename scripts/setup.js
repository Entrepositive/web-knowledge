#!/usr/bin/env node
// Interactive first-run / key-rotation wizard for web-knowledge.
// Run via: docker compose run --rm web-knowledge npm run setup
// Reads any existing .env, prompts for each provider key (Enter = keep
// current value), auto-generates/rotates the API bearer token, and
// writes .env (mode 600). No web UI, no password — whoever has shell
// access to run this already has access to the host.
import readline from 'readline';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', '.env');

const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const BANNER = `
${GREEN}oooo    oooo
 o888   o888
  888  .8'
  888.8'
  888  8b.
  888   88b.
o888o   o888o${RESET}
${DIM}web-knowledge — setup${RESET}
`;

const PROVIDER_KEYS = [
  { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', required: true, url: 'https://console.anthropic.com/' },
  { name: 'TAVILY_API_KEY', label: 'Tavily API key', required: false, url: 'https://tavily.com/' },
  { name: 'EXA_API_KEY', label: 'Exa API key', required: false, url: 'https://exa.ai/' },
  { name: 'BRAVE_API_KEY', label: 'Brave Search API key', required: false, url: 'https://brave.com/search/api/' },
  { name: 'SERPER_API_KEY', label: 'Serper.dev API key', required: false, url: 'https://serper.dev/' },
  { name: 'FIRECRAWL_API_KEY', label: 'Firecrawl API key', required: false, url: 'https://firecrawl.dev/' },
];

function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function mask(value) {
  if (!value) return '(not set)';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

// A queued-line reader, not readline's built-in question() — question()'s
// one-shot 'line' listener silently drops any extra lines that arrive in the
// same burst as the one it consumes (e.g. pasting several keys at once, or
// piping pre-written answers). This permanent listener queues every line as
// it arrives so nothing is ever lost regardless of timing.
function makeAsker(rl) {
  const queue = [];
  let resolveNext = null;
  rl.on('line', (line) => {
    if (resolveNext) { const r = resolveNext; resolveNext = null; r(line); }
    else queue.push(line);
  });
  return function ask(promptText) {
    process.stdout.write(promptText);
    if (queue.length > 0) return Promise.resolve(queue.shift());
    return new Promise((resolve) => { resolveNext = resolve; });
  };
}

async function main() {
  process.stdout.write(BANNER);

  const existing = fs.existsSync(ENV_PATH) ? parseEnv(fs.readFileSync(ENV_PATH, 'utf8')) : {};
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = makeAsker(rl);
  const values = { ...existing };

  console.log('For each key: press Enter to keep the current value, or type a new one.\n');

  for (const p of PROVIDER_KEYS) {
    const current = existing[p.name];
    const prompt = `${p.label}${p.required ? ' (required)' : ' (optional — skip to disable this provider)'}\n  [current: ${mask(current)}] (${p.url})\n> `;
    const answer = await ask(prompt);
    if (answer.trim()) {
      values[p.name] = answer.trim();
    } else if (current) {
      values[p.name] = current;
    } else {
      values[p.name] = '';
    }
    console.log('');
  }

  // API bearer token — auto-generated, not typed. Protects /search and
  // /read from being called by anyone who can reach this service but
  // shouldn't be able to spend your provider quota.
  let token = existing.WK_API_TOKEN;
  if (token) {
    const rotate = await ask(
      `An API token is already set. Rotate it? This breaks any caller (e.g. n8n)\nuntil you update it with the new value there too. [y/N]\n> `
    );
    if (rotate.trim().toLowerCase() === 'y') {
      token = crypto.randomBytes(32).toString('hex');
    }
  } else {
    token = crypto.randomBytes(32).toString('hex');
  }
  values.WK_API_TOKEN = token;

  // Non-secret config — carry over existing values or fall back to sane defaults.
  values.ANTHROPIC_MODEL = existing.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  values.CACHE_TTL_HOURS = existing.CACHE_TTL_HOURS || '24';
  values.PORT = existing.PORT || '4242';
  // Always the in-Docker-network address of the SearXNG sidecar — compose
  // overrides this at container-start regardless, kept here for clarity
  // when running src/index.js outside Docker.
  values.SEARXNG_URL = existing.SEARXNG_URL || 'http://localhost:4243';

  rl.close();

  if (!values.ANTHROPIC_API_KEY) {
    console.log('\nWarning: no Anthropic key set — query optimization and answer synthesis will fail.\n');
  }

  const out = `# web-knowledge — generated by scripts/setup.js on ${new Date().toISOString()}
# Re-run \`npm run setup\` any time to change a key or rotate the API token.

ANTHROPIC_API_KEY=${values.ANTHROPIC_API_KEY}
ANTHROPIC_MODEL=${values.ANTHROPIC_MODEL}

TAVILY_API_KEY=${values.TAVILY_API_KEY}
SEARXNG_URL=${values.SEARXNG_URL}
EXA_API_KEY=${values.EXA_API_KEY}
BRAVE_API_KEY=${values.BRAVE_API_KEY}
SERPER_API_KEY=${values.SERPER_API_KEY}
FIRECRAWL_API_KEY=${values.FIRECRAWL_API_KEY}

CACHE_TTL_HOURS=${values.CACHE_TTL_HOURS}
PORT=${values.PORT}

# Required header on every /search and /read request: X-WK-Token: <this value>
WK_API_TOKEN=${values.WK_API_TOKEN}
`;

  fs.writeFileSync(ENV_PATH, out, { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);

  console.log(`${GREEN}Done.${RESET} Wrote ${ENV_PATH}\n`);
  console.log(`API token (send as header  X-WK-Token: <value>  on every request):\n${GREEN}${token}${RESET}\n`);
  console.log('Next: docker compose up -d --build\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
