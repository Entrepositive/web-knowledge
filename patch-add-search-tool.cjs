#!/usr/bin/env node
// patch-add-search-tool.js
// Adds search_web toolCode node to Manon Slack AI Agent (R615lNDRXn7dTkKO)

const axios = require('axios');

const N8N_API_KEY = process.env.N8N_MANON_API_KEY;
const N8N_HOST = 'http://172.18.0.2:5678';
const WORKFLOW_ID = 'R615lNDRXn7dTkKO';

async function main() {
  const { data: wf } = await axios.get(`${N8N_HOST}/api/v1/workflows/${WORKFLOW_ID}`, {
    headers: { 'X-N8N-API-KEY': N8N_API_KEY }
  });
  console.log('Fetched:', wf.name, '— nodes:', wf.nodes.length);

  // Check not already added
  if (wf.nodes.find(n => n.name === 'search_web')) {
    console.log('search_web node already exists — nothing to do');
    return;
  }

  // Position near other tool nodes
  const kodiNode = wf.nodes.find(n => n.name === 'Kodi Control');
  const posX = kodiNode ? kodiNode.position[0] : 1200;
  const posY = kodiNode ? kodiNode.position[1] + 200 : 600;

  const searchWebNode = {
    id: 'search-web-tool-001',
    name: 'search_web',
    type: '@n8n/n8n-nodes-langchain.toolCode',
    typeVersion: 1,
    position: [posX, posY],
    parameters: {
      name: 'search_web',
      description: [
        'Search the web and return a synthesized factual answer.',
        'Use this when you need current information, facts, definitions, or anything you are not certain about.',
        '',
        '## CRITICAL: Tool input format',
        'Input must be a plain string — the search query.',
        'Example: search_web("when do cherry blossoms peak in Tokyo")',
        '',
        'Returns a synthesized answer with sources.'
      ].join('\n'),
      jsCode: [
        'const axios = require("axios");',
        'const res = await axios.post("http://localhost:4242/search", { query }, {',
        '  timeout: 15000',
        '});',
        'const d = res.data;',
        'const sourceList = (d.sources || []).slice(0, 3)',
        '  .map((s, i) => `[${i+1}] ${s.title} — ${s.url}`)',
        '  .join("\\n");',
        'return `${d.answer}\\n\\nSources:\\n${sourceList}`;'
      ].join('\n')
    }
  };

  wf.nodes.push(searchWebNode);

  // Connect search_web to Manon Agent as a tool
  const agentNode = wf.nodes.find(n => n.name === 'Manon Agent');
  if (agentNode) {
    if (!wf.connections['search_web']) wf.connections['search_web'] = {};
    wf.connections['search_web']['ai_tool'] = [
      [{ node: 'Manon Agent', type: 'ai_tool', index: 0 }]
    ];
    console.log('Connected search_web → Manon Agent as ai_tool');
  }

  // PUT updated workflow
  const payload = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: { executionOrder: wf.settings?.executionOrder || 'v1' }
  };

  await axios.put(`${N8N_HOST}/api/v1/workflows/${WORKFLOW_ID}`, payload, {
    headers: { 'X-N8N-API-KEY': N8N_API_KEY }
  });
  console.log('✅ search_web tool added to Manon Slack AI Agent');
}

main().catch(err => {
  console.error('Error:', err.response?.data || err.message);
  process.exit(1);
});
