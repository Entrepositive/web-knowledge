import axios from 'axios';
import { isProviderAvailable, markProviderExhausted, markProviderDegraded, incrementProviderCalls, logRead } from '../db.js';

const MAX_CHARS = 4000;
const MONTHLY_RESET = 30 * 24 * 3600;

// Every provider call resolves to { ok: true, result } or { ok: false, reason }
// so readUrl can log exactly what happened at each step of the cascade.
async function tryProvider(name, fn) {
  if (!isProviderAvailable(name)) return { ok: false, reason: 'unavailable' };
  try {
    incrementProviderCalls(name, 'read');
    const result = await fn();
    if (!result) return { ok: false, reason: 'empty' };
    result.source = name;
    return { ok: true, result };
  } catch (err) {
    const status = err.response?.status;
    if (status === 429 || status === 402) {
      console.warn(`[read] ${name} quota hit — marking exhausted for 30 days`);
      markProviderExhausted(name, 'read', Math.floor(Date.now() / 1000) + MONTHLY_RESET);
      return { ok: false, reason: `quota(${status})` };
    }
    console.warn(`[read] ${name} error (${status || err.message}) — degraded 5 min`);
    markProviderDegraded(name, 'read');
    return { ok: false, reason: `error(${status || err.message})` };
  }
}

async function readJina(url) {
  return tryProvider('jina', async () => {
    const res = await axios.get(`https://r.jina.ai/${url}`, {
      headers: { Accept: 'text/markdown' },
      timeout: 10000,
    });
    const content = res.data?.slice(0, MAX_CHARS) || null;
    if (!content || content.length < 100) return null;
    // Extract title from first line if it looks like a heading
    let title = '';
    const lines = content.split('\n');
    if (lines[0]?.startsWith('#')) {
      title = lines[0].replace(/^#+\s*/, '').trim();
    }
    return { content, title };
  });
}

async function readTavilyExtract(url) {
  if (!process.env.TAVILY_API_KEY) return { ok: false, reason: 'no_key' };
  return tryProvider('tavily-extract', async () => {
    const res = await axios.post('https://api.tavily.com/extract', {
      api_key: process.env.TAVILY_API_KEY,
      urls: [url],
    }, { timeout: 10000 });
    const result = res.data.results?.[0];
    const content = result?.raw_content?.slice(0, MAX_CHARS) || null;
    if (!content || content.length < 100) return null;
    return { content, title: result?.title || '' };
  });
}

async function readFirecrawl(url) {
  if (!process.env.FIRECRAWL_API_KEY) return { ok: false, reason: 'no_key' };
  return tryProvider('firecrawl', async () => {
    const res = await axios.post('https://api.firecrawl.dev/v1/scrape', {
      url,
      formats: ['markdown'],
    }, {
      headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
      timeout: 12000,
    });
    const content = res.data.data?.markdown?.slice(0, MAX_CHARS) || null;
    if (!content || content.length < 100) return null;
    return { content, title: res.data.data?.metadata?.title || '' };
  });
}

async function readRawHttp(url) {
  return tryProvider('raw-http', async () => {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; web-knowledge/1.0)' },
      timeout: 8000,
      responseType: 'text',
    });
    // Strip HTML tags
    const text = res.data
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const content = text.slice(0, MAX_CHARS) || null;
    if (!content || content.length < 100) return null;
    // Try to extract title from HTML title tag if available
    const titleMatch = res.data.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    return { content, title };
  });
}

const BLOCK_SIGNATURES = [
  /attention required.{0,30}cloudflare/i,
  /checking your browser before accessing/i,
  /just a moment\.\.\./i,
  /enable javascript and cookies to continue/i,
  /please complete the security check/i,
  /cf-browser-verification/i,
  /verify you are human/i,
  /access denied/i,
  /target url returned error \d{3}/i,
];

function looksBlocked(content) {
  return BLOCK_SIGNATURES.some(re => re.test(content));
}

export async function readUrl(url) {
  const startTime = Date.now();
  const providers = [
    ['raw-http', readRawHttp],
    ['jina', readJina],
    ['tavily-extract', readTavilyExtract],
    ['firecrawl', readFirecrawl],
  ];

  const attempts = [];
  let final = null;

  for (const [name, fn] of providers) {
    const outcome = await fn(url);
    if (!outcome.ok) {
      attempts.push({ provider: name, outcome: outcome.reason });
      continue;
    }
    if (outcome.result.content.length <= 100) {
      attempts.push({ provider: name, outcome: 'too_short' });
      continue;
    }
    if (looksBlocked(outcome.result.content)) {
      attempts.push({ provider: name, outcome: 'blocked' });
      continue;
    }
    attempts.push({ provider: name, outcome: 'ok' });
    final = outcome.result;
    break;
  }

  const durationMs = Date.now() - startTime;
  const summary = attempts.map(a => `${a.provider}:${a.outcome}`).join(' ');
  console.log(`[read] ${url} -> ${final ? 'success via ' + final.source : 'failed'} (${durationMs}ms) [${summary}]`);
  logRead(url, attempts, final?.source || null, durationMs);

  return final;
}

export async function readUrls(urls) {
  return Promise.all(urls.map(url => readUrl(url)));
}
