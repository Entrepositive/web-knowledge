import { missingConfig, CONFIG_PATH } from './config.js'; // keep first: loads config before other modules read process.env
import express from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { search } from './providers/search.js';
import { readUrl, readUrls } from './providers/read.js';
import { optimizeQuery, synthesize } from './synthesize.js';
import { getCached, setCache, touchCache, saveToLibrary, getCachedRead, setCacheRead, touchCacheRead } from './db.js';

const app = express();
app.use(express.json());

const limiter = rateLimit({
  windowMs: 10 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down' },
});
app.use('/search', limiter);

// Until setup has run, the service still starts (so /health can say what's
// wrong instead of crash-looping) but refuses real work. Requests are never
// served unauthenticated.
const SETUP_HINT = 'Run setup: docker compose run --rm web-knowledge npm run setup';
const missing = missingConfig();
if (missing.length) {
  console.warn(`[web-knowledge] NOT CONFIGURED — missing ${missing.join(', ')} (looked in ${CONFIG_PATH}). ${SETUP_HINT}`);
}

// Require X-WK-Token on /search and /read — without it, anyone who can
// reach this service can spend your provider quota.
function checkToken(req, res, next) {
  if (missing.length) {
    return res.status(503).json({ error: `Service not configured (missing ${missing.join(', ')}). ${SETUP_HINT}` });
  }
  const expected = process.env.WK_API_TOKEN;
  const provided = req.headers['x-wk-token'] || '';
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  const valid = expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
  if (!valid) return res.status(401).json({ error: 'Invalid or missing X-WK-Token header' });
  next();
}
app.use(['/search', '/read'], checkToken);

const PORT = process.env.PORT || 4242;

// Startup: log active providers
function logActiveProviders() {
  const searchProviders = ['tavily', 'searxng', 'exa', 'brave', 'serper', 'ddg'];
  const readProviders = ['jina', 'tavily-extract', 'firecrawl', 'raw-http'];
  const keyMap = {
    tavily: 'TAVILY_API_KEY', exa: 'EXA_API_KEY',
    brave: 'BRAVE_API_KEY', serper: 'SERPER_API_KEY',
    firecrawl: 'FIRECRAWL_API_KEY',
  };
  const noKeyNeeded = new Set(['searxng', 'ddg', 'jina', 'tavily-extract', 'raw-http']);

  const activeSearch = searchProviders.filter(p => noKeyNeeded.has(p) || process.env[keyMap[p]]);
  const skippedSearch = searchProviders.filter(p => !noKeyNeeded.has(p) && !process.env[keyMap[p]]);
  const activeRead = readProviders.filter(p => noKeyNeeded.has(p) || process.env[keyMap[p]]);
  const skippedRead = readProviders.filter(p => !noKeyNeeded.has(p) && !process.env[keyMap[p]]);

  console.log(`[web-knowledge] Search providers: ${activeSearch.join(', ')}`);
  if (skippedSearch.length) console.log(`[web-knowledge] Skipped (no key): ${skippedSearch.join(', ')}`);
  console.log(`[web-knowledge] Read providers:   ${activeRead.join(', ')}`);
  if (skippedRead.length) console.log(`[web-knowledge] Skipped (no key): ${skippedRead.join(', ')}`);
}

app.get('/health', (req, res) => {
  if (missing.length) {
    return res.status(503).json({ status: 'unconfigured', missing, fix: SETUP_HINT });
  }
  res.json({ status: 'ok', service: 'K — web-knowledge' });
});

app.post('/search', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query is required' });
  }

  const queryHash = crypto.createHash('sha256').update(query.trim().toLowerCase()).digest('hex');

  // Cache check
  const cached = getCached(queryHash);
  if (cached) {
    touchCache(queryHash); // rolling window — extends expires_at, never created_at
    return res.json({
      answer: cached.answer,
      sources: JSON.parse(cached.sources),
      cached: true,
      search_provider: 'cache',
      read_provider: 'cache',
    });
  }

  try {
    // Query optimization
    const queryOptimized = await optimizeQuery(query);
    console.log(`[search] "${query}" → "${queryOptimized}"`);

    // Search
    const searchResult = await search(queryOptimized);
    const topResults = searchResult.results.slice(0, 5);

    // Content reading — skip if search provider bundled content
    let pageContents;
    if (searchResult.content_bundled) {
      pageContents = topResults.map(r => r.raw_content);
    } else {
      const urls = topResults.map(r => r.url);
      const readResults = await readUrls(urls);
      pageContents = readResults.map(r => r?.content || null);
    }

    // Synthesis
    const answer = await synthesize(query, topResults, pageContents);

    // ── USAGE TRACKING HOOK ──────────────────────────────────────────────────
    // Production: fire a Stripe Meter event here (1 credit per successful search).
    // req.headers['x-wk-token'] is already verified by checkToken() above (Task 10, done).
    // await stripe.billing.meterEvents.create({ event_name: 'search', payload: { stripe_customer_id: lookupCustomer(req.headers['x-wk-token']), value: '1' } });
    // ─────────────────────────────────────────────────────────────────────────

    // Determine read provider used
    const readProvider = searchResult.content_bundled ? searchResult.provider : 'jina+cascade';

    // Persist
    const sources = topResults.map(r => ({ title: r.title, url: r.url, snippet: r.snippet }));
    setCache(queryHash, query, answer, sources);
    saveToLibrary(query, queryOptimized, answer, sources, searchResult.provider, readProvider);

    return res.json({
      answer,
      sources,
      cached: false,
      search_provider: searchResult.provider,
      read_provider: readProvider,
    });
  } catch (err) {
    console.error('[search] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/read', async (req, res) => {
  const { url, timeout_ms } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  const urlHash = crypto.createHash('sha256').update(url.trim().toLowerCase()).digest('hex');
  const timeoutMs = timeout_ms || 8000;
  const timestamp = new Date().toISOString();

  // Cache check
  const cached = getCachedRead(urlHash);
  if (cached) {
    touchCacheRead(urlHash); // rolling window — extends expires_at, never created_at
    return res.json({
      success: true,
      url: cached.url,
      title: cached.title,
      content: cached.content,
      source: cached.source,
      content_length: cached.content_length,
      timestamp,
      cached: true,
    });
  }

  try {
    console.log(`[read] Fetching ${url}`);
    const result = await readUrl(url);

    if (!result) {
      return res.status(500).json({
        success: false,
        url,
        error: 'Timeout after 4 failed providers',
        timestamp,
      });
    }

    const { content, title, source } = result;
    const contentLength = content.length;

    // Cache the result
    setCacheRead(urlHash, url, title, content, source, contentLength);

    return res.json({
      success: true,
      url,
      title,
      content,
      source,
      content_length: contentLength,
      timestamp,
      cached: false,
    });
  } catch (err) {
    console.error('[read] error:', err.message);
    return res.status(500).json({
      success: false,
      url,
      error: err.message,
      timestamp,
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[web-knowledge] Listening on port ${PORT}`);
  logActiveProviders();
});
