#!/usr/bin/env node
// First-run / reconfiguration wizard for web-knowledge.
//
//   docker compose run --rm web-knowledge npm run setup
//       Interactive. Prompts for each provider key (Enter keeps the current
//       value) and generates the API token on first run.
//
//   docker compose run --rm -e ANTHROPIC_API_KEY -e TAVILY_API_KEY ... \
//       web-knowledge npm run setup -- --non-interactive [--rotate-token]
//       No prompts. Takes keys from environment variables (`-e NAME` with no
//       value passes your shell's variable through, so secrets never appear
//       on the command line), keeps existing values for anything not given,
//       generates the token if there isn't one. Exits non-zero if
//       ANTHROPIC_API_KEY ends up unset.
//
//   docker compose exec -T web-knowledge npm run -s token
//       Prints the current API token and nothing else.
//
// Writes data/config.env (mode 600). No web UI — whoever can run this
// already has access to the host.
import readline from 'readline';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.WK_DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.env');

const args = new Set(process.argv.slice(2));
const NON_INTERACTIVE = args.has('--non-interactive');
const ROTATE_TOKEN = args.has('--rotate-token');
const SHOW_TOKEN = args.has('--show-token');

const color = process.stdout.isTTY;
const GREEN = color ? '\x1b[32m' : '';
const DIM = color ? '\x1b[2m' : '';
const RESET = color ? '\x1b[0m' : '';

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

const DEFAULTS = { ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001', CACHE_TTL_HOURS: '24' };

// Written by older versions, now fixed by docker-compose.yml — dropped on rewrite.
const OBSOLETE = new Set(['PORT', 'SEARXNG_URL']);

function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

// Pasted keys sometimes arrive wrapped in quotes or with stray whitespace.
function clean(value) {
  return (value || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

function mask(value) {
  if (!value) return '(not set)';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function readExisting() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  if (!fs.statSync(CONFIG_PATH).isFile()) {
    throw new Error(`${CONFIG_PATH} exists but is not a file — remove it and run setup again`);
  }
  return parseEnv(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// A queued-line reader, not readline's built-in question() — question()'s
// one-shot 'line' listener silently drops any extra lines that arrive in the
// same burst as the one it consumes (e.g. pasting several keys at once, or
// piping pre-written answers). This permanent listener queues every line as
// it arrives so nothing is ever lost regardless of timing. If input ends
// before all questions are answered, ask() resolves to null.
function makeAsker(rl) {
  const queue = [];
  let resolveNext = null;
  let closed = false;
  rl.on('line', (line) => {
    if (resolveNext) { const r = resolveNext; resolveNext = null; r(line); }
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    if (resolveNext) { const r = resolveNext; resolveNext = null; r(null); }
  });
  return function ask(promptText) {
    process.stdout.write(promptText);
    if (queue.length > 0) return Promise.resolve(queue.shift());
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => { resolveNext = resolve; });
  };
}

async function collectInteractive(existing, values) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = makeAsker(rl);
  const inputEnded = () => {
    rl.close();
    throw new Error('Input ended before setup finished — nothing was written. For scripted installs use --non-interactive (see README).');
  };

  console.log(`For each key: press Enter to keep the current value, or paste a new one.\n`);
  for (const p of PROVIDER_KEYS) {
    const current = existing[p.name];
    const answer = await ask(
      `${p.label}${p.required ? ' (required)' : ' (optional — Enter to skip)'}\n  [current: ${mask(current)}] (${p.url})\n> `
    );
    if (answer === null) inputEnded();
    if (clean(answer)) values[p.name] = clean(answer);
    console.log('');
  }

  if (values.WK_API_TOKEN) {
    const rotate = await ask(
      `An API token is already set. Rotate it? Anything using the old token\n(e.g. n8n) stops working until you give it the new one. [y/N]\n> `
    );
    if (rotate === null) inputEnded();
    if (rotate.trim().toLowerCase() === 'y') values.WK_API_TOKEN = newToken();
  }
  rl.close();
}

function writeConfig(values) {
  const known = new Set([...PROVIDER_KEYS.map((p) => p.name), ...Object.keys(DEFAULTS), 'WK_API_TOKEN']);
  const extras = Object.entries(values).filter(([k]) => !known.has(k) && !OBSOLETE.has(k));

  const out = `# web-knowledge configuration — written by \`npm run setup\` on ${new Date().toISOString()}
# Re-run setup to change a key or rotate the token. Hand edits are fine too;
# restart the service afterwards: docker compose restart web-knowledge

ANTHROPIC_API_KEY=${values.ANTHROPIC_API_KEY || ''}
ANTHROPIC_MODEL=${values.ANTHROPIC_MODEL}

TAVILY_API_KEY=${values.TAVILY_API_KEY || ''}
EXA_API_KEY=${values.EXA_API_KEY || ''}
BRAVE_API_KEY=${values.BRAVE_API_KEY || ''}
SERPER_API_KEY=${values.SERPER_API_KEY || ''}
FIRECRAWL_API_KEY=${values.FIRECRAWL_API_KEY || ''}

CACHE_TTL_HOURS=${values.CACHE_TTL_HOURS}
${extras.map(([k, v]) => `${k}=${v}\n`).join('')}
# Callers must send this on every /search and /read request:  X-WK-Token: <value>
WK_API_TOKEN=${values.WK_API_TOKEN}
`;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, CONFIG_PATH);
}

async function main() {
  const existing = readExisting();

  if (SHOW_TOKEN) {
    if (!existing.WK_API_TOKEN) {
      console.error('No API token configured yet — run setup first.');
      process.exit(1);
    }
    console.log(existing.WK_API_TOKEN);
    return;
  }

  const values = { ...DEFAULTS, ...existing };

  if (NON_INTERACTIVE) {
    for (const p of PROVIDER_KEYS) {
      if (clean(process.env[p.name])) values[p.name] = clean(process.env[p.name]);
    }
    for (const k of Object.keys(DEFAULTS)) {
      if (clean(process.env[k])) values[k] = clean(process.env[k]);
    }
    if (ROTATE_TOKEN) values.WK_API_TOKEN = newToken();
  } else {
    process.stdout.write(BANNER);
    await collectInteractive(existing, values);
  }

  const tokenIsNew = !values.WK_API_TOKEN || values.WK_API_TOKEN !== existing.WK_API_TOKEN;
  if (!values.WK_API_TOKEN) values.WK_API_TOKEN = newToken();

  writeConfig(values);

  const active = PROVIDER_KEYS.filter((p) => values[p.name]).map((p) => p.name);
  console.log(`${GREEN}Saved${RESET} ${CONFIG_PATH}`);
  console.log(`Keys set: ${active.join(', ') || '(none)'}`);

  if (!values.ANTHROPIC_API_KEY) {
    console.error('\nERROR: ANTHROPIC_API_KEY is not set. The service will not answer /search or /read until it is.');
    process.exit(1);
  }

  console.log(`\nAPI token${tokenIsNew ? ' (NEW)' : ''} — send it as the header  X-WK-Token: <token>`);
  console.log(`${GREEN}${values.WK_API_TOKEN}${RESET}`);
  console.log(`${DIM}Print it again any time: docker compose exec -T web-knowledge npm run -s token${RESET}\n`);
  console.log('If the service is already running, apply the change: docker compose restart web-knowledge');
}

main().catch((err) => {
  console.error(`Setup failed: ${err.message}`);
  process.exit(1);
});
