import WebSocket from 'ws';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

const orchestratorUrl = process.env.ORCH_WS;
const agentKey = process.env.AGENT_KEY;

if (!orchestratorUrl || !agentKey) {
  console.error('Error: Missing ORCH_WS or AGENT_KEY environment variables.');
  console.error('Please ensure a .env file exists in the agent directory with these values.');
  process.exit(1);
}

// Append agent key as query parameter for authentication
const connectUrl = `${orchestratorUrl}?AGENT_KEY=${encodeURIComponent(agentKey)}`;

console.log(`Attempting to connect to: ${orchestratorUrl}`); // Log without the key

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY_MS = 1000; // 1 second
const MAX_RECONNECT_DELAY_MS = 30 * 1000; // 30 seconds
let reconnectTimeoutId: NodeJS.Timeout | null = null;
let pingIntervalId: NodeJS.Timeout | null = null; // For heartbeat
const PING_INTERVAL_MS = 30 * 1000; // 30 seconds
let isClosingGracefully = false; // Flag to prevent reconnect on intentional close

// --- Message Interfaces (Example) ---
interface BaseMessage {
    action: string;
    requestId?: string; // Optional request ID for tracking
    timestamp?: number | string;
}

interface PingMessage extends BaseMessage {
    action: 'ping';
    data?: any; // Optional data for ping
}

interface PongMessage extends BaseMessage {
    action: 'pong';
    receivedData?: any; // Echoed data from ping
}

// Add more interfaces for job requests, responses etc. later
// interface JobRequestMessage extends BaseMessage { action: 'job_request'; data: { jobId: string; url: string; ... } }
// interface JobResponseMessage extends BaseMessage { action: 'job_response'; data: { jobId: string; statusCode: number; ... } }

function connect() {
  if (reconnectTimeoutId) {
    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
  }
  isClosingGracefully = false; // Reset flag on new connection attempt
  console.log('Initiating connection...');
  ws = new WebSocket(connectUrl);

  ws.on('open', () => {
    console.log('✅ Connected to Orchestrator.');
    reconnectAttempts = 0; // Reset attempts on successful connection
    startPing(); // Start heartbeat on successful connection
  });

  ws.on('message', (data) => {
    try {
      const message: BaseMessage = JSON.parse(data.toString());
      console.log(`📩 Received action: ${message.action}`);

      // Simple message router
      switch (message.action) {
        case 'pong':
          handlePong(message as PongMessage);
          break;
        // case 'job_request': // TODO: Handle job requests (Task 5)
        //   handleJobRequest(message as JobRequestMessage);
        //   break;
        default:
          console.warn(`Unknown action received: ${message.action}`);
      }
    } catch (error) {
      console.error('Error parsing or handling incoming message:', error);
      console.error('Raw message:', data.toString());
    }
  });

  ws.on('close', (code, reason) => {
    const reasonString = reason.toString() || 'No reason provided';
    console.log(`❌ Disconnected from Orchestrator. Code: ${code}, Reason: ${reasonString}`);
    stopPing(); // Stop heartbeat on disconnect
    ws = null;
    if (!isClosingGracefully) {
        attemptReconnect();
    }
  });

  ws.on('error', (error) => {
    console.error(' WebSocket Error:', error.message);
    stopPing(); // Stop ping on error too
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        ws.close();
    }
  });
}

function attemptReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
        // Optional: Exit or notify an administrator
        // process.exit(1);
        return;
    }

    reconnectAttempts++;
    // Exponential backoff with jitter
    const delay = Math.min(
        INITIAL_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1) + Math.random() * 1000,
        MAX_RECONNECT_DELAY_MS
    );

    console.log(`Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay / 1000)}s...`);

    reconnectTimeoutId = setTimeout(() => {
        connect();
    }, delay);
}

// --- Heartbeat (Ping/Pong) ---
function startPing() {
    stopPing(); // Clear existing interval if any
    console.log(`Starting heartbeat ping every ${PING_INTERVAL_MS / 1000}s`);
    pingIntervalId = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            const pingMsg: PingMessage = {
                action: 'ping',
                timestamp: Date.now(),
                // requestId: uuidv4() // Add request ID if needed for tracking pongs
            };
            console.log(`	💓 Sending ping...`);
            ws.send(JSON.stringify(pingMsg));
        } else {
            console.warn('Cannot send ping, WebSocket not open.');
            // Connection might be closing or already closed, reconnect logic will handle it.
        }
    }, PING_INTERVAL_MS);
}

function stopPing() {
    if (pingIntervalId) {
        console.log('Stopping heartbeat ping.');
        clearInterval(pingIntervalId);
        pingIntervalId = null;
    }
}

function handlePong(message: PongMessage) {
    console.log(`	💓 Received pong. Round trip latency (if timestamp included): ${message.timestamp ? Date.now() - Number(message.timestamp) : 'N/A'} ms`);
    // Optionally track latency or confirm connection is alive
}

// Initial connection attempt
connect();

// Keep the agent running (optional, depends on deployment strategy)
// process.stdin.resume(); // Keep node process alive

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('SIGINT received. Closing connection gracefully...');
  isClosingGracefully = true; // Set flag to prevent reconnection
  stopPing(); // Stop ping on shutdown
  if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId); // Cancel any pending reconnect
  }
  if (ws) {
    ws.close(1000, 'Agent shutting down'); // Close with a normal code
  }
  // Allow time for close event to process before exiting
  setTimeout(() => process.exit(0), 500);
});
