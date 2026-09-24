import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

export async function optimizeQuery(query) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: `Convert this search term into an optimal web search query. Return only the query string, nothing else.\n\nSearch term: ${query}`,
    }],
  });
  return msg.content[0].text.trim();
}

export async function synthesize(query, searchResults, pageContents) {
  const sourcesBlock = searchResults.map((r, i) => {
    const content = pageContents[i] ? `\nContent: ${pageContents[i]}` : '';
    return `[${i + 1}] ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}${content}`;
  }).join('\n\n');

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: 'You are a factual research assistant. Given a search query and web sources, write a concise, accurate answer in 2-4 sentences. Synthesize across sources. No preamble, no "based on the sources", just the answer.',
    messages: [{
      role: 'user',
      content: `Query: ${query}\n\nSources:\n${sourcesBlock}`,
    }],
  });
  return msg.content[0].text.trim();
}
