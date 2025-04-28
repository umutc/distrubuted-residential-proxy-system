#!/usr/bin/env node
// Mini POC: Validate WebSocket endpoint
// Usage:
//   1. Install dependencies: npm install ws dotenv
//   2. Create a .env file at project root with: WS_ENDPOINT=wss://{apiId}.execute-api.{region}.amazonaws.com/dev
//   3. Run: node scripts/validate-ws.js

require('dotenv').config();
const WebSocket = require('ws');

const endpointBase = process.env.WS_ENDPOINT;
const agentKey = process.env.AGENT_KEY;
if (!endpointBase) {
  console.error('Error: WS_ENDPOINT not set in environment.');
  process.exit(1);
}

if (!agentKey) {
  console.error('Error: AGENT_KEY not set in environment.');
  process.exit(1);
}

// Append agent key as query parameter for authentication
const separator = endpointBase.includes('?') ? '&' : '?';
const endpoint = `${endpointBase}${separator}AGENT_KEY=${encodeURIComponent(agentKey)}`;

console.log(`Connecting to ${endpoint}...`);
const ws = new WebSocket(endpoint);

ws.on('open', () => {
  console.log('✔ Connected');
  // Send a test action; you can change 'ping' to any supported action
  const message = { action: 'ping', data: { timestamp: Date.now() } };
  console.log('→ Sending:', message);
  ws.send(JSON.stringify(message));
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data);
    console.log('← Received JSON:', msg);
  } catch (err) {
    console.log('← Received raw:', data.toString());
  }
  // Close after response for POC
  console.log('Closing connection');
  ws.close();
});

ws.on('close', () => {
  console.log('✖ Disconnected');
});

ws.on('error', (err) => {
  console.error('Error:', err.message);
}); 