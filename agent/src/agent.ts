import WebSocket from 'ws';
import dotenv from 'dotenv';
import { request } from 'undici';

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

// --- Job Interfaces ---
interface JobRequestData {
    jobId: string;
    url: string;
    method: string; // GET, POST, etc.
    headers?: Record<string, string>;
    body?: string; // Base64 encoded for binary, otherwise string
    bodyEncoding?: 'base64' | 'utf8'; // Optional: specify encoding if body is present
    timeoutMs?: number; // Optional timeout for the request
}

interface JobRequestMessage extends BaseMessage {
    action: 'job_request';
    data: JobRequestData;
}

// Add more interfaces for job responses etc. later
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
        case 'job_request':
          handleJobRequest(message as JobRequestMessage);
          break;
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

// --- Job Handling ---

function handleJobRequest(message: JobRequestMessage) {
    console.log(`Received job request for jobId: ${message.data?.jobId || 'N/A'}`);

    // --- Robust Validation ---
    if (!message.data) {
        console.error('Invalid job request: Missing data field.');
        sendErrorResponse(message.requestId, undefined, 'Invalid job request: Missing data field');
        return;
    }

    const { jobId, url, method, headers, body, bodyEncoding, timeoutMs } = message.data;

    if (!jobId || typeof jobId !== 'string') {
        sendErrorResponse(message.requestId, jobId, 'Invalid job request: Missing or invalid jobId');
        return;
    }
    if (!url || typeof url !== 'string') {
        sendErrorResponse(message.requestId, jobId, 'Invalid job request: Missing or invalid url');
        return;
    }
    // Basic URL validation (can be enhanced)
    try {
        new URL(url);
    } catch (e) {
        sendErrorResponse(message.requestId, jobId, 'Invalid job request: Malformed URL');
        return;
    }

    if (!method || typeof method !== 'string' || !['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
        sendErrorResponse(message.requestId, jobId, `Invalid job request: Missing or invalid method: ${method}`);
        return;
    }

    if (headers && typeof headers !== 'object') {
        sendErrorResponse(message.requestId, jobId, 'Invalid job request: headers must be an object');
        return;
    }

    if (body && typeof body !== 'string') {
        sendErrorResponse(message.requestId, jobId, 'Invalid job request: body must be a string (potentially Base64 encoded)');
        return;
    }

    if (bodyEncoding && !['base64', 'utf8'].includes(bodyEncoding)) {
        sendErrorResponse(message.requestId, jobId, `Invalid job request: invalid bodyEncoding: ${bodyEncoding}. Must be 'base64' or 'utf8'.`);
        return;
    }

    if (timeoutMs && typeof timeoutMs !== 'number') {
        sendErrorResponse(message.requestId, jobId, 'Invalid job request: timeoutMs must be a number');
        return;
    }
    // --- End Validation ---

    let requestBody: Buffer | string | undefined = undefined;
    if (body) {
        if (bodyEncoding === 'base64') {
            try {
                requestBody = Buffer.from(body, 'base64');
            } catch (e: any) {
                sendErrorResponse(message.requestId, jobId, `Invalid job request: Failed to decode base64 body: ${e.message}`);
                return;
            }
        } else { // Default to utf8 if encoding is 'utf8' or not specified
            requestBody = body;
        }
    }

    // Implement actual HTTP execution (Subtask 5.2)
    console.log(`Executing job ${jobId}: ${method} ${url}`);
    // Pass the potentially decoded Buffer or original string
    executeHttpRequest(jobId, url, method, headers, requestBody, timeoutMs, message.requestId);
}

async function executeHttpRequest(
    jobId: string,
    url: string,
    method: string,
    headers?: Record<string, string>,
    body?: Buffer | string, // Accept Buffer or string
    timeoutMs?: number,
    requestId?: string
) {
    const MAX_REDIRECTS = 5;
    const DEFAULT_TIMEOUT = 30000; // 30 seconds
    const requestTimeout = timeoutMs || DEFAULT_TIMEOUT;

    try {
        console.log(`[${jobId}] Making ${method} request to ${url}`);

        const requestOptions: any = {
            method: method.toUpperCase(),
            headers: headers || {},
            maxRedirections: MAX_REDIRECTS,
            headersTimeout: requestTimeout, // Timeout for receiving headers
            bodyTimeout: requestTimeout, // Timeout for receiving the body
            // TODO: Add more options if needed (e.g., custom agent for proxy)
        };

        // Only add body if method allows it and body is present
        if (body && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
            requestOptions.body = body;
        }

        const { statusCode, headers: responseHeaders, body: responseBodyStream } = await request(url, requestOptions);

        console.log(`[${jobId}] Received status code: ${statusCode}`);

        // Read the response body into a buffer
        const chunks: Buffer[] = []; // Explicitly type chunks as Buffer[]
        for await (const chunk of responseBodyStream) {
            chunks.push(Buffer.from(chunk)); // Ensure chunk is treated as Buffer
        }
        const responseBodyBuffer = Buffer.concat(chunks);

        // TODO: Implement response formatting (Subtask 5.3)
        sendSuccessResponse(requestId, jobId, statusCode, responseHeaders as Record<string, string>, responseBodyBuffer);

    } catch (error: any) {
        console.error(`[${jobId}] Error executing HTTP request:`, error.message);
        sendErrorResponse(requestId, jobId, `HTTP request failed: ${error.message}`, error.statusCode);
    }
}

function sendSuccessResponse(requestId: string | undefined, jobId: string, statusCode: number, headers: Record<string, string>, body: Buffer) {
    // Determine if body should be Base64 encoded (e.g., based on content-type or just default to it)
    // Simple approach: Assume binary if content-type suggests it, or if it's not easily identified as text.
    // More robust: Check content-type for known text types (text/*, application/json, application/xml, etc.)
    const contentType = headers['content-type']?.toLowerCase() || '';
    const isTextBased = contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml') || contentType.includes('javascript');

    const responseBody = isTextBased ? body.toString('utf8') : body.toString('base64');
    const isBase64Encoded = !isTextBased;

    const responseMessage = {
        action: 'job_response',
        requestId: requestId, // Include original request ID if available
        data: {
            jobId: jobId,
            status: 'success',
            result: {
                statusCode: statusCode,
                headers: headers,
                body: responseBody,
                isBase64Encoded: isBase64Encoded
            }
        }
    };
    sendMessage(responseMessage);
}

function sendErrorResponse(requestId: string | undefined, jobId: string | undefined, error: string, statusCode?: number) {
    const responseMessage = {
        action: 'job_response',
        requestId: requestId,
        data: {
            jobId: jobId || 'unknown',
            status: 'failure',
            error: {
                message: error,
                statusCode: statusCode
            }
        }
    };
    sendMessage(responseMessage);
}

// Utility to send messages
function sendMessage(message: BaseMessage) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            const messageString = JSON.stringify(message);
            console.log(`	🚀 Sending message: ${message.action}`);
            ws.send(messageString);
        } catch (err: any) { // Use 'any' or a more specific error type
            console.error('Error stringifying or sending message:', err.message);
        }
    } else {
        console.error(`Cannot send message, WebSocket not open or not initialized. Action: ${message.action}`);
    }
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
