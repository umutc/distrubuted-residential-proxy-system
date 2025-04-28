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

// Structure for standardized errors
interface AgentError {
    code: string; // e.g., AGENT_NETWORK_ERROR, AGENT_TARGET_ERROR, AGENT_TIMEOUT
    message: string;
    statusCode?: number; // HTTP status code from target if relevant
    details?: any; // Any additional context
}

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
        sendErrorResponse(message.requestId, undefined, 'Invalid job request: Missing data field', 'AGENT_VALIDATION_ERROR');
        return;
    }

    const { jobId, url, method, headers, body, bodyEncoding, timeoutMs } = message.data;

    if (!jobId || typeof jobId !== 'string') {
        sendErrorResponse(message.requestId, jobId, 'Invalid job request: Missing or invalid jobId', 'AGENT_VALIDATION_ERROR');
        return;
    }
    if (!url || typeof url !== 'string') {
        sendErrorResponse(message.requestId, jobId, 'Invalid job request: Missing or invalid url', 'AGENT_VALIDATION_ERROR');
        return;
    }
    // Basic URL validation (can be enhanced)
    try {
        new URL(url);
    } catch (e) {
        sendErrorResponse(message.requestId, jobId, 'Invalid job request: Malformed URL', 'AGENT_VALIDATION_ERROR');
        return;
    }

    if (!method || typeof method !== 'string' || !['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
        sendErrorResponse(message.requestId, jobId, `Invalid job request: Missing or invalid method: ${method}`, 'AGENT_VALIDATION_ERROR');
        return;
    }

    if (headers && typeof headers !== 'object') {
        sendErrorResponse(message.requestId, jobId, 'Invalid job request: headers must be an object', 'AGENT_VALIDATION_ERROR');
        return;
    }

    if (body && typeof body !== 'string') {
        sendErrorResponse(message.requestId, jobId, 'Invalid job request: body must be a string (potentially Base64 encoded)', 'AGENT_VALIDATION_ERROR');
        return;
    }

    if (bodyEncoding && !['base64', 'utf8'].includes(bodyEncoding)) {
        sendErrorResponse(message.requestId, jobId, `Invalid job request: invalid bodyEncoding: ${bodyEncoding}. Must be 'base64' or 'utf8'.`, 'AGENT_VALIDATION_ERROR');
        return;
    }

    if (timeoutMs && typeof timeoutMs !== 'number') {
        sendErrorResponse(message.requestId, jobId, 'Invalid job request: timeoutMs must be a number', 'AGENT_VALIDATION_ERROR');
        return;
    }
    // --- End Validation ---

    let requestBody: Buffer | string | undefined = undefined;
    if (body) {
        if (bodyEncoding === 'base64') {
            try {
                requestBody = Buffer.from(body, 'base64');
            } catch (e: any) {
                sendErrorResponse(message.requestId, jobId, `Invalid job request: Failed to decode base64 body: ${e.message}`, 'AGENT_VALIDATION_ERROR');
                return;
            }
        } else { // Default to utf8 if encoding is 'utf8' or not specified
            requestBody = body;
        }
    }

    // Implement actual HTTP execution
    console.log(`Executing job ${jobId}: ${method.toUpperCase()} ${url}`);
    // Use a non-blocking approach
    executeHttpRequest(
        jobId,
        url,
        method.toUpperCase(),
        headers,
        requestBody,
        timeoutMs,
        message.requestId
    ).catch(executionError => {
        // This catch is a safety net for unexpected errors within executeHttpRequest itself
        console.error(`[${jobId}] Unexpected error during executeHttpRequest promise:`, executionError);
        sendErrorResponse(message.requestId, jobId, 'Internal agent error during job execution', 'AGENT_INTERNAL_ERROR');
    });
}

/**
 * Executes the HTTP request based on job data.
 */
async function executeHttpRequest(
    jobId: string,
    url: string,
    method: string,
    headers?: Record<string, string>,
    body?: Buffer | string, // Accept Buffer or string
    timeoutMs?: number,
    requestId?: string
) {
    const controller = new AbortController();
    const timeout = timeoutMs || 30000; // Default 30s timeout
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        console.log(`[${jobId}] Sending request to ${url} with timeout ${timeout}ms`);
        const res = await request(url, {
            method: method,
            headers: headers,
            body: body,
            signal: controller.signal,
            // TODO: Add redirect handling if needed: follow: 5
        });
        clearTimeout(timeoutId);

        console.log(`[${jobId}] Received response: ${res.statusCode}`);

        // Read response body
        const responseBodyBuffer = Buffer.from(await res.body.arrayBuffer());

        // Handle non-2xx status codes as errors
        if (res.statusCode < 200 || res.statusCode >= 300) {
            console.warn(`[${jobId}] Target server returned non-2xx status: ${res.statusCode}`);
            let errorDetails: any = responseBodyBuffer.toString('utf8'); // Attempt to parse body as text
            try {
                 // Try parsing as JSON if content-type suggests it
                 if (res.headers['content-type']?.includes('application/json')) {
                    errorDetails = JSON.parse(errorDetails);
                 }
            } catch (parseError) {
                 // Ignore if body is not valid JSON
                 console.log(`[${jobId}] Response body for error status ${res.statusCode} is not JSON.`);
            }
            sendErrorResponse(
                requestId,
                jobId,
                `Target server responded with status ${res.statusCode}`,
                'AGENT_TARGET_ERROR',
                res.statusCode,
                { responseBody: errorDetails } // Include response body in details
            );
            return; // Stop processing on error
        }

        // Success: Send response back to orchestrator
        sendSuccessResponse(
            requestId,
            jobId,
            res.statusCode,
            res.headers as Record<string, string>, // Cast might be needed
            responseBodyBuffer
        );

    } catch (error: any) {
        clearTimeout(timeoutId);
        console.error(`[${jobId}] Error executing HTTP request:`, error);

        let errorCode = 'AGENT_UNKNOWN_ERROR';
        let errorMessage = error.message || 'Unknown error executing request';
        let statusCode: number | undefined = undefined;

        if (error.name === 'AbortError' || error.code === 'UND_ERR_ABORTED') {
            errorCode = 'AGENT_TIMEOUT';
            errorMessage = `Request timed out after ${timeout}ms`;
        } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
            errorCode = 'AGENT_NETWORK_ERROR';
            errorMessage = `Network error: ${error.code || error.message}`;
        } else if (error.statusCode) {
             // Sometimes undici might throw errors with status codes (e.g., invalid URL?)
             errorCode = 'AGENT_REQUEST_ERROR';
             statusCode = error.statusCode;
        }
        // Add more specific error code mappings as needed

        sendErrorResponse(requestId, jobId, errorMessage, errorCode, statusCode);
    }
}

/**
 * Sends a successful job response back to the Orchestrator.
 */
function sendSuccessResponse(requestId: string | undefined, jobId: string, statusCode: number, headers: Record<string, string>, body: Buffer) {
    // Base64 encode body for safe JSON transport
    const bodyBase64 = body.toString('base64');
    const isBase64Encoded = true; // Always encode for simplicity, receiver can decode

    const responseMessage = {
        action: 'job_response',
        requestId: requestId, // Include original request ID if available
        data: {
            jobId: jobId,
            status: 'success',
            result: {
                statusCode: statusCode,
                headers: headers,
                body: bodyBase64,
                isBase64Encoded: isBase64Encoded,
            },
        },
    };
    console.log(`[${jobId}] Sending success response.`);
    sendMessage(responseMessage);
}

/**
 * Sends an error job response back to the Orchestrator.
 */
function sendErrorResponse(requestId: string | undefined, jobId: string | undefined, message: string, errorCode: string, statusCode?: number, details?: any) {
    console.error(`[${jobId || 'N/A'}] Sending error response: Code=${errorCode}, Msg=${message}`);
    const errorPayload: AgentError = {
        code: errorCode,
        message: message,
        statusCode: statusCode,
        details: details,
    };
    const responseMessage = {
        action: 'job_response',
        requestId: requestId,
        data: {
            jobId: jobId || 'unknown', // Include jobId if known
            status: 'failure',
            error: errorPayload,
        },
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
