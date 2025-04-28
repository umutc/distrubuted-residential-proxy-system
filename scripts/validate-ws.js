#!/usr/bin/env node
// Mini POC: Validate WebSocket endpoint
// Usage:
//   1. Install dependencies: npm install ws dotenv
//   2. Export WS_ENDPOINT and AGENT_KEY environment variables
//   3. Run: node scripts/validate-ws.js

// require('dotenv').config(); // Removed dotenv dependency
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

  // 1. Send ping
  const pingMsg = { action: 'ping', requestId: `ping-${Date.now()}` };
  console.log('→ Sending:', pingMsg);
  ws.send(JSON.stringify(pingMsg));

  // 2. Send register after a delay
  setTimeout(() => {
    const registerMsg = {
      action: 'register',
      requestId: `register-${Date.now()}`,
      data: {
        agentId: `test-script-agent-${Math.random().toString(36).substring(7)}`,
        capabilities: ['test', 'script'],
        metadata: { scriptVersion: '1.0' }
      }
    };
    console.log('→ Sending:', registerMsg);
    ws.send(JSON.stringify(registerMsg));
  }, 1000);

  // 3. Send invalid action after another delay
  setTimeout(() => {
    const invalidMsg = { action: 'bad_action', requestId: `bad-${Date.now()}` };
    console.log('→ Sending:', invalidMsg);
    ws.send(JSON.stringify(invalidMsg));
  }, 2000);

  // 4. Send job_response after another delay
  setTimeout(() => {
    const jobResponseMsg = {
        action: 'job_response',
        requestId: `job-${Date.now()}`,
        data: {
            jobId: `job-${Math.random().toString(36).substring(7)}`,
            status: 'success',
            result: { message: 'Script test successful' }
        }
    };
    console.log('→ Sending:', jobResponseMsg);
    ws.send(JSON.stringify(jobResponseMsg));
  }, 3000);

  // 5. Close after all tests
  setTimeout(() => {
    console.log('Closing connection after tests.');
    ws.close();
  }, 5000);
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString()); // Ensure data is string before parsing
    console.log('← Received JSON:', msg);
  } catch (err) {
    console.log('← Received raw:', data.toString());
  }
  // Keep connection open for a bit longer to test more actions if needed
  // console.log('Closing connection');
  // ws.close();
});

ws.on('close', () => {
  console.log('✖ Disconnected');
});

ws.on('error', (err) => {
  console.error('Error:', err.message);
}); 