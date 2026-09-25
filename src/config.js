// Where web-knowledge keeps its runtime state, and loading its config.
//
// Everything that must survive a container rebuild lives in ONE directory,
// DATA_DIR (default: <repo>/data, mounted from the host as ./data):
//   data/config.env    — provider API keys + the X-WK-Token (written by setup)
//   data/knowledge.db  — SQLite cache/history
// Mounting a directory rather than individual files is deliberate: if a
// bind-mounted *file* is missing on the host, Docker silently creates a
// directory in its place and the app crash-loops. A missing directory is
// just created, which is exactly what we want.
//
// Real environment variables always win over config.env, so orchestrators
// can inject values without touching the file.
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.WK_DATA_DIR || path.join(__dirname, '..', 'data');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.env');
export const DB_PATH = path.join(DATA_DIR, 'knowledge.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

if (fs.existsSync(CONFIG_PATH)) {
  if (!fs.statSync(CONFIG_PATH).isFile()) {
    throw new Error(`${CONFIG_PATH} exists but is not a file — remove it and re-run setup`);
  }
  dotenv.config({ path: CONFIG_PATH, quiet: true });
}

// The service is "configured" once setup has provided the two values it
// cannot work without. Until then it still starts (so /health can explain
// what's wrong) but refuses /search and /read.
export function missingConfig() {
  return ['ANTHROPIC_API_KEY', 'WK_API_TOKEN'].filter((k) => !process.env[k]);
}
