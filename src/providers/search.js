import axios from 'axios';
import { isProviderAvailable, markProviderExhausted, markProviderDegraded, incrementProviderCalls } from '../db.js';

const MONTHLY_RESET = 30 * 24 * 3600;

async function tryProvider(name, fn) {
  if (!isProviderAvailable(name)) return null;
  try {
    incrementProviderCalls(name, 'search');
    return await fn();
  } catch (err) {
    const status = err.response?.status;
    if (status === 429 || status === 402) {
      console.warn(`[search] ${name} quota hit — marking exhausted for 30 days`);
      markProviderExhausted(name, 'search', Math.floor(Date.now() / 1000) + MONTHLY_RESET);
    } else {
      console.warn(`[search] ${name} error (${status || err.message}) — degraded 5 min`);
      markProviderDegraded(name, 'search');
    }
    return null;
  }
}

async function searchTavily(query) {
  if (!process.env.TAVILY_API_KEY) return null;
  return tryProvider('tavily', async () => {
    const res = await axios.post('https://api.tavily.com/search', {
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: 'basic',
      include_raw_content: true,
      max_results: 5,
    }, { timeout: 8000 });
    const results = res.data.results || [];
    return {
      provider: 'tavily',
      results: results.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        raw_content: r.raw_content || null,
      })),
      content_bundled: true,
    };
  });
}

async function searchSearXNG(query) {
  const url = process.env.SEARXNG_URL || 'http://localhost:4243';
  return tryProvider('searxng', async () => {
    const res = await axios.get(`${url}/search`, {
      params: { q: query, format: 'json', language: 'en' },
      timeout: 8000,
    });
    const results = (res.data.results || []).slice(0, 10);
    return {
      provider: 'searxng',
      results: results.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content || '',
        raw_content: null,
      })),
      content_bundled: false,
    };
  });
}

async function searchExa(query) {
  if (!process.env.EXA_API_KEY) return null;
  return tryProvider('exa', async () => {
    const res = await axios.post('https://api.exa.ai/search', {
      query,
      numResults: 5,
      contents: { text: { maxCharacters: 4000 } },
    }, {
      headers: { 'x-api-key': process.env.EXA_API_KEY },
      timeout: 8000,
    });
    const results = res.data.results || [];
    return {
      provider: 'exa',
      results: results.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.text ? r.text.slice(0, 300) : '',
        raw_content: r.text || null,
      })),
      content_bundled: true,
    };
  });
}

async function searchBrave(query) {
  if (!process.env.BRAVE_API_KEY) return null;
  return tryProvider('brave', async () => {
    const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      params: { q: query, count: 8 },
      headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY },
      timeout: 8000,
    });
    const results = res.data.web?.results || [];
    return {
      provider: 'brave',
      results: results.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.description || '',
        raw_content: null,
      })),
      content_bundled: false,
    };
  });
}

async function searchSerper(query) {
  if (!process.env.SERPER_API_KEY) return null;
  return tryProvider('serper', async () => {
    const res = await axios.post('https://google.serper.dev/search', { q: query }, {
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY },
      timeout: 8000,
    });
    const results = res.data.organic || [];
    return {
      provider: 'serper',
      results: results.slice(0, 8).map(r => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet || '',
        raw_content: null,
      })),
      content_bundled: false,
    };
  });
}

async function searchDDG(query) {
  return tryProvider('ddg', async () => {
    const res = await axios.get('https://html.duckduckgo.com/html/', {
      params: { q: query },
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; web-knowledge/1.0)' },
      timeout: 8000,
    });
    const html = res.data;
    const results = [];
    const regex = /class="result__title"[^>]*>.*?href="([^"]+)"[^>]*>([^<]+)/gs;
    let match;
    while ((match = regex.exec(html)) !== null && results.length < 8) {
      results.push({ title: match[2].trim(), url: match[1], snippet: '', raw_content: null });
    }
    return { provider: 'ddg', results, content_bundled: false };
  });
}

export async function search(query) {
  const providers = [searchTavily, searchSearXNG, searchExa, searchBrave, searchSerper, searchDDG];
  for (const fn of providers) {
    const result = await fn(query);
    if (result && result.results.length > 0) return result;
  }
  throw new Error('All search providers failed or returned no results');
}
