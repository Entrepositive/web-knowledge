import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'knowledge.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    query_hash   TEXT PRIMARY KEY,
    query        TEXT,
    answer       TEXT,
    sources      TEXT,
    created_at   INTEGER,
    expires_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS read_cache (
    url_hash     TEXT PRIMARY KEY,
    url          TEXT,
    title        TEXT,
    content      TEXT,
    source       TEXT,
    content_length INTEGER,
    created_at   INTEGER,
    expires_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS library (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    query            TEXT,
    query_optimized  TEXT,
    answer           TEXT,
    sources          TEXT,
    search_provider  TEXT,
    read_provider    TEXT,
    created_at       INTEGER,
    tags             TEXT
  );

  CREATE TABLE IF NOT EXISTS provider_status (
    provider     TEXT PRIMARY KEY,
    type         TEXT,
    status       TEXT DEFAULT 'active',
    calls_today  INTEGER DEFAULT 0,
    calls_month  INTEGER DEFAULT 0,
    last_failure INTEGER,
    skip_until   INTEGER
  );

  CREATE TABLE IF NOT EXISTS read_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    url          TEXT,
    success      INTEGER,
    source       TEXT,
    attempts     TEXT,
    duration_ms  INTEGER,
    created_at   INTEGER
  );
`);

export function getCached(queryHash) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT * FROM cache WHERE query_hash = ? AND expires_at > ?'
  ).get(queryHash, now);
}

export function setCache(queryHash, query, answer, sources) {
  const now = Math.floor(Date.now() / 1000);
  const ttlHours = parseInt(process.env.CACHE_TTL_HOURS || '24');
  db.prepare(`
    INSERT OR REPLACE INTO cache (query_hash, query, answer, sources, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(queryHash, query, answer, JSON.stringify(sources), now, now + ttlHours * 3600);
}

// Rolling-window refresh on a cache HIT: extends expires_at only.
// created_at is a permanent record of when this entry was first cached —
// it must never be touched here (that's the flush job's source of truth).
export function touchCache(queryHash) {
  const now = Math.floor(Date.now() / 1000);
  const ttlHours = parseInt(process.env.CACHE_TTL_HOURS || '24');
  db.prepare('UPDATE cache SET expires_at = ? WHERE query_hash = ?')
    .run(now + ttlHours * 3600, queryHash);
}

export function saveToLibrary(query, queryOptimized, answer, sources, searchProvider, readProvider) {
  db.prepare(`
    INSERT INTO library (query, query_optimized, answer, sources, search_provider, read_provider, created_at, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(query, queryOptimized, answer, JSON.stringify(sources), searchProvider, readProvider,
    Math.floor(Date.now() / 1000), '[]');
}

export function getProviderStatus(provider) {
  return db.prepare('SELECT * FROM provider_status WHERE provider = ?').get(provider);
}

export function markProviderExhausted(provider, type, skipUntil) {
  db.prepare(`
    INSERT INTO provider_status (provider, type, status, skip_until, last_failure)
    VALUES (?, ?, 'exhausted', ?, ?)
    ON CONFLICT(provider) DO UPDATE SET status='exhausted', skip_until=?, last_failure=?
  `).run(provider, type, skipUntil, Math.floor(Date.now() / 1000),
         skipUntil, Math.floor(Date.now() / 1000));
}

export function markProviderDegraded(provider, type) {
  const skipUntil = Math.floor(Date.now() / 1000) + 300; // 5 min
  db.prepare(`
    INSERT INTO provider_status (provider, type, status, skip_until, last_failure)
    VALUES (?, ?, 'degraded', ?, ?)
    ON CONFLICT(provider) DO UPDATE SET status='degraded', skip_until=?, last_failure=?
  `).run(provider, type, skipUntil, Math.floor(Date.now() / 1000),
         skipUntil, Math.floor(Date.now() / 1000));
}

export function isProviderAvailable(provider) {
  const row = getProviderStatus(provider);
  if (!row) return true;
  if (row.status === 'active') return true;
  const now = Math.floor(Date.now() / 1000);
  if (row.skip_until && now > row.skip_until) {
    db.prepare('UPDATE provider_status SET status=\'active\', skip_until=NULL WHERE provider=?')
      .run(provider);
    return true;
  }
  return false;
}

export function incrementProviderCalls(provider, type) {
  db.prepare(`
    INSERT INTO provider_status (provider, type, calls_today, calls_month)
    VALUES (?, ?, 1, 1)
    ON CONFLICT(provider) DO UPDATE SET calls_today=calls_today+1, calls_month=calls_month+1
  `).run(provider, type);
}

export function getCachedRead(urlHash) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT * FROM read_cache WHERE url_hash = ? AND expires_at > ?'
  ).get(urlHash, now);
}

export function setCacheRead(urlHash, url, title, content, source, contentLength) {
  const now = Math.floor(Date.now() / 1000);
  const ttlHours = parseInt(process.env.CACHE_TTL_HOURS || '24');
  db.prepare(`
    INSERT OR REPLACE INTO read_cache (url_hash, url, title, content, source, content_length, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(urlHash, url, title, content, source, contentLength, now, now + ttlHours * 3600);
}

// Rolling-window refresh on a cache HIT: extends expires_at only.
// created_at is a permanent record of when this entry was first cached —
// it must never be touched here (that's the flush job's source of truth).
export function touchCacheRead(urlHash) {
  const now = Math.floor(Date.now() / 1000);
  const ttlHours = parseInt(process.env.CACHE_TTL_HOURS || '24');
  db.prepare('UPDATE read_cache SET expires_at = ? WHERE url_hash = ?')
    .run(now + ttlHours * 3600, urlHash);
}

export function logRead(url, attempts, source, durationMs) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO read_log (url, success, source, attempts, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(url, source ? 1 : 0, source, JSON.stringify(attempts), durationMs, now);
}
