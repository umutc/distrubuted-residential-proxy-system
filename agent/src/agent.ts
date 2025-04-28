import WebSocket from 'ws';
import dotenv from 'dotenv';
import { request } from 'undici';
import { setTimeout, clearTimeout } from 'node:timers'; // Explicit Node timers
import { Buffer } from 'node:buffer'; // Explicit Node buffer
import process from 'node:process'; // Explicit Node process

// Load environment variables from .env file
dotenv.config();

const orchestratorUrl = process.env.ORCH_WS;
const agentKey = process.env.AGENT_KEY;
const GRACE_PERIOD_MS = parseInt(process.env.AGENT_GRACE_PERIOD_MS || '10000', 10); // Default 10 seconds

if (!orchestratorUrl || !agentKey) {
  console.error('Error: Missing ORCH_WS or AGENT_KEY environment variables.');
  console.error('Please ensure a .env file exists in the agent directory with these values.');
  process.exit(1); // Exit code 1 for configuration error
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
let isShuttingDown = false; // Flag for graceful shutdown process
const activeJobs = new Set<string>(); // Track IDs of jobs currently being processed
let shutdownTimeoutId: NodeJS.Timeout | null = null; // Timer for grace period

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
interface JobResponseMessage extends BaseMessage {
  action: 'job_response';
  requestId?: string;
  data: {
    jobId: string;
    success: boolean;
    response?: {
      statusCode: number;
      headers: Record<string, string>;
      body: string; // Base64 encoded
    };
    error?: AgentError;
  };
}

// Structure for standardized errors
interface AgentError {
    code: string; // e.g., AGENT_NETWORK_ERROR, AGENT_TARGET_ERROR, AGENT_TIMEOUT
    message: string;
    statusCode?: number; // HTTP status code from target if relevant
    details?: any; // Any additional context
}

function connect() {
  if (isShuttingDown) {
      console.log("Shutdown in progress, connection aborted.");
      return;
  }
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
    if (isShuttingDown) {
        console.log("Received message during shutdown, ignoring.");
        return; // Ignore messages during shutdown phase
    }
    try {
      const message: BaseMessage = JSON.parse(data.toString());
      console.log(`📩 Received action: ${message.action}`);

      // Simple message router
      switch (message.action) {
        case 'pong':
          handlePong(message as PongMessage);
          break;
        case 'job_request':
          handleJobRequest(message as JobRequestMessage); // Async handling needed
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
    // Reconnect only if not shutting down intentionally (gracefully or due to max attempts)
    if (!isClosingGracefully && !isShuttingDown && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        attemptReconnect();
    } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
         console.error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Not attempting further connections.`);
         // Optionally exit or notify
         // gracefulShutdown(1); // Consider triggering shutdown if reconnect fails permanently
    }
  });

  ws.on('error', (error) => {
    console.error(' WebSocket Error:', error.message);
    stopPing(); // Stop ping on error too
    // Attempt to close cleanly, the 'close' event will handle reconnect logic
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        console.log('Closing WebSocket due to error.');
        ws.close(1011, "WebSocket Error"); // Use appropriate code if needed
    }
    // Note: The 'close' event handler should trigger the reconnect logic if appropriate
  });
}

function attemptReconnect() {
    if (isShuttingDown) {
        console.log("Shutdown in progress, reconnect aborted.");
        return;
    }
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
        gracefulShutdown(1); // Trigger shutdown if reconnect fails permanently
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
        if (ws && ws.readyState === WebSocket.OPEN && !isShuttingDown) {
            const pingMsg: PingMessage = {
                action: 'ping',
                timestamp: Date.now(),
                // requestId: uuidv4() // Add request ID if needed for tracking pongs
            };
            console.log(`	💓 Sending ping...`);
            sendMessage(pingMsg); // Use sendMessage for consistency
        } else if (isShuttingDown) {
             console.log('Not sending ping, shutdown in progress.');
             stopPing(); // Stop pinging during shutdown
        } else {
            console.warn('Cannot send ping, WebSocket not open or shutting down.');
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
    // Only log if not shutting down, less noise
    if (!isShuttingDown) {
        console.log(`	💓 Received pong. Round trip latency (if timestamp included): ${message.timestamp ? Date.now() - Number(message.timestamp) : 'N/A'} ms`);
    }
    // Optionally track latency or confirm connection is alive
}

// --- Job Handling ---

// Make handleJobRequest async as executeHttpRequest is async
async function handleJobRequest(message: JobRequestMessage) {
    // 1. Check if shutting down
    if (isShuttingDown) {
      console.log(`Received job request ${message.data?.jobId} during shutdown, rejecting.`);
      sendErrorResponse(message.requestId, message.data?.jobId, 'Agent is shutting down', 'AGENT_SHUTTING_DOWN');
      return;
    }

    console.log(`Received job request for jobId: ${message.data?.jobId || 'N/A'}`);

    // --- Robust Validation ---
    if (!message.data) {
        console.error('Invalid job request: Missing data field.');
        sendErrorResponse(message.requestId, undefined, 'Invalid job request: Missing data field', 'AGENT_VALIDATION_ERROR');
        return;
    }

    const { jobId, url, method, headers, body, bodyEncoding, timeoutMs } = message.data;

    // Basic validation (keep concise for example)
    if (!jobId || !url || !method) {
         sendErrorResponse(message.requestId, jobId, 'Invalid job request: Missing required fields (jobId, url, method)', 'AGENT_VALIDATION_ERROR');
         return;
    }
     try {
        new URL(url); // Basic URL format check
    } catch (e) {
        sendErrorResponse(message.requestId, jobId, 'Invalid job request: Malformed URL', 'AGENT_VALIDATION_ERROR');
        return;
    }
     if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
        sendErrorResponse(message.requestId, jobId, `Invalid job request: Invalid method: ${method}`, 'AGENT_VALIDATION_ERROR');
        return;
    }
    // Add other validations as needed...
    // --- End Validation ---

    // 2. Add job to active set *before* execution
    activeJobs.add(jobId);
    console.log(`Job ${jobId} added to active set (${activeJobs.size} active).`);

    try {
        let requestBody: Buffer | string | undefined = undefined;
        if (body) {
            if (bodyEncoding === 'base64') {
                try {
                    requestBody = Buffer.from(body, 'base64');
                } catch (e: any) {
                    // Cannot return here directly, need to go to finally block to remove from activeJobs
                    // Throw an error instead to be caught by the outer catch block
                    throw new Error(`Failed to decode base64 body: ${e.message}`);
                }
            } else {
                requestBody = body; // Assume utf8 if not base64
            }
        }
        // Execute the HTTP request
        await executeHttpRequest(jobId, url, method, headers, requestBody, timeoutMs, message.requestId);

    } catch (error) {
        // Catch errors *during* the setup/preparation before executeHttpRequest
        // OR errors thrown deliberately (like the base64 decode failure)
        console.error(`[${jobId}] Error during job request handling or setup:`, error);
        // Ensure an error response is sent IF executeHttpRequest wasn't the source of the error
        // (executeHttpRequest sends its own errors)
        // Check if the error originated from our setup phase
        if (!(error instanceof Error && error.message.startsWith('Failed executing HTTP request'))) { // Heuristic check
             sendErrorResponse(message.requestId, jobId, `Internal agent error during job setup: ${error instanceof Error ? error.message : String(error)}`, 'AGENT_INTERNAL_ERROR', 500);
        }
    } finally {
        // 3. Remove job from active set in finally block
        activeJobs.delete(jobId);
        console.log(`Job ${jobId} removed from active set (${activeJobs.size} active).`);

        // 4. Check if shutdown is pending and this was the last job
        if (isShuttingDown && activeJobs.size === 0) {
            console.log('Last active job completed during shutdown.');
            if (shutdownTimeoutId) {
                clearTimeout(shutdownTimeoutId); // Cancel the force-shutdown timer
                shutdownTimeoutId = null;
            }
            closeConnectionAndExit(0); // Exit cleanly
        }
    }
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
    console.log(`[${jobId}] Executing ${method} request to ${url}`);
    const effectiveTimeout = timeoutMs || 30000; // Default 30s timeout

    try {
        const { statusCode, headers: responseHeaders, body: responseBodyStream } = await request(url, {
            method: method.toUpperCase(),
            headers: {
                ...headers, // Spread incoming headers
                'User-Agent': `DistributedAgent/1.0 (JobId: ${jobId})`, // Example User-Agent
            },
            body: body,
            bodyTimeout: effectiveTimeout, // Timeout for receiving the body
            headersTimeout: effectiveTimeout, // Timeout for receiving headers
            // connectTimeout: 10000, // Removed as it's not standard
            // Allow throwing errors for non-2xx status codes for simpler handling below
            // throwOnError: true, // Consider if this simplifies error logic vs checking statusCode
        });

        console.log(`[${jobId}] Received response: ${statusCode}`);

        // Consume the stream and collect into a buffer
        const chunks: Buffer[] = []; // Explicitly type chunks as Buffer[]
        for await (const chunk of responseBodyStream) {
            chunks.push(chunk);
        }
        const completeBodyBuffer = Buffer.concat(chunks);

        // Convert headers object (IncomingHttpHeaders) to simple Record<string, string>
        const simpleHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(responseHeaders)) {
           if (value !== undefined) {
             // Handle single string value, array of strings, or undefined
             simpleHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
           }
        }

        // Send success (even for non-2xx status codes from the target)
        sendSuccessResponse(requestId, jobId, statusCode, simpleHeaders, completeBodyBuffer);

    } catch (error: any) {
        console.error(`[${jobId}] Error executing HTTP request:`, error);

        // Wrap error message for clarity in finally block check
        const errorMessagePrefix = 'Failed executing HTTP request: ';
        let errorCode = 'AGENT_REQUEST_FAILED';
        let message = `${errorMessagePrefix}Unknown error`;
        let statusCode: number | undefined = undefined; // HTTP status from error if available

        if (error && typeof error === 'object') {
             // undici specific errors often have codes
            if ('code' in error) {
                message = `${errorMessagePrefix}${error.code} - ${error.message}`;
                if (error.code === 'UND_ERR_CONNECT_TIMEOUT') { // Note: connectTimeout is implicit in headersTimeout usually
                    errorCode = 'AGENT_CONNECT_TIMEOUT';
                } else if (error.code === 'UND_ERR_HEADERS_TIMEOUT' || error.code === 'UND_ERR_BODY_TIMEOUT') {
                    errorCode = 'AGENT_TARGET_TIMEOUT';
                } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
                     errorCode = 'AGENT_TARGET_UNREACHABLE';
                } // Add more specific undici error codes if needed
            } else {
                 message = `${errorMessagePrefix}${error.message || 'Unknown error'}`;
            }
             // Check if it resembles an HTTP error structure from undici or target
            if ('statusCode' in error && typeof error.statusCode === 'number') {
                statusCode = error.statusCode;
                errorCode = 'AGENT_TARGET_ERROR'; // Consider it a target error if status code present
                message = `${errorMessagePrefix}Target responded with status ${statusCode}`;
            } else if ('response' in error && error.response && 'statusCode' in error.response && typeof error.response.statusCode === 'number') {
                // Handle cases where undici wraps the response in error
                statusCode = error.response.statusCode;
                errorCode = 'AGENT_TARGET_ERROR';
                message = `${errorMessagePrefix}Target responded with status ${statusCode}`;
            }
        } else {
            message = `${errorMessagePrefix}${String(error)}`;
        }

        // Cast error to unknown when passing as details
        sendErrorResponse(requestId, jobId, message, errorCode, statusCode, error as unknown);
        // Explicitly create and type the error object before throwing
        const executionError: Error = new Error(String(message));
        throw executionError;
    }
}

function sendSuccessResponse(requestId: string | undefined, jobId: string, statusCode: number, headers: Record<string, string>, body: Buffer) {
    const response: JobResponseMessage = {
        action: 'job_response',
        requestId: requestId, // Include original requestId if present
        timestamp: Date.now(),
        data: {
            jobId: jobId,
            success: true,
            response: {
                statusCode: statusCode,
                headers: headers,
                body: body.toString('base64') // Always encode body as Base64
            }
        }
    };
    sendMessage(response);
    console.log(`[${jobId}] Success response sent (Target Status: ${statusCode}).`);
}

function sendErrorResponse(requestId: string | undefined, jobId: string | undefined, message: string, errorCode: string, statusCode?: number, details?: any) {
     // Ensure jobId is included if available, even if it's just from the initial request
    const effectiveJobId = jobId || (requestId ? `unknown_job_for_${requestId}` : 'unknown_job');

    const errorResponse: JobResponseMessage = {
        action: 'job_response',
        requestId: requestId,
        timestamp: Date.now(),
        data: {
            jobId: effectiveJobId,
            success: false,
            error: {
                code: errorCode,
                message: message,
                statusCode: statusCode, // Include original status if available (e.g., 404 from target)
                details: details ? JSON.stringify(details) : undefined // Add extra context if needed
            }
        }
    };
    sendMessage(errorResponse);
     console.error(`[${effectiveJobId}] Error response sent: ${errorCode} - ${message}`);
}

function sendMessage(message: BaseMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('Error sending message:', error);
      // Attempt to close connection if send fails, reconnect logic will handle it
       if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close(1011, "Send Error");
       }
    }
  } else {
    console.warn(`Cannot send message (Action: ${message.action}), WebSocket not open.`);
    // Don't attempt reconnect here, let the close/error handlers manage it
  }
}

// --- Graceful Shutdown Logic ---
function gracefulShutdown(exitCode: number = 0) {
    if (isShuttingDown) {
        console.log('Shutdown already in progress.');
        return; // Prevent redundant shutdown calls
    }
    isShuttingDown = true;
    console.log(`🚨 Initiating graceful shutdown (Exit code: ${exitCode})...`);
    stopPing(); // Stop sending pings

    if (reconnectTimeoutId) {
        clearTimeout(reconnectTimeoutId); // Cancel any pending reconnect
        reconnectTimeoutId = null;
    }

    if (activeJobs.size === 0) {
        console.log('No active jobs. Shutting down immediately.');
        closeConnectionAndExit(exitCode);
    } else {
        console.log(`Waiting for ${activeJobs.size} active job(s) to complete (max ${GRACE_PERIOD_MS / 1000}s)...`);
        console.log('Active job IDs:', Array.from(activeJobs));

        // Set a timer to force exit if jobs don't finish
        shutdownTimeoutId = setTimeout(() => {
            console.warn(`Grace period (${GRACE_PERIOD_MS / 1000}s) expired. Forcing shutdown.`);
            console.warn(`Jobs still active: ${Array.from(activeJobs).join(', ')}`);
            closeConnectionAndExit(1); // Use non-zero exit code for forced shutdown
        }, GRACE_PERIOD_MS);
    }
}

function closeConnectionAndExit(exitCode: number) {
     console.log(`Closing WebSocket connection and exiting with code ${exitCode}...`);
     isClosingGracefully = true; // Prevent reconnect attempts from the 'close' handler
     if (shutdownTimeoutId) { // Clear timeout if we are exiting before it fires
        clearTimeout(shutdownTimeoutId);
        shutdownTimeoutId = null;
     }

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'Graceful shutdown'); // 1000 is normal closure
    } else if (ws && ws.readyState === WebSocket.CONNECTING) {
         ws.terminate(); // Force close if still connecting
    }
     // Add a small delay to allow the close frame to potentially be sent
    setTimeout(() => {
        console.log("Exiting process.");
        process.exit(exitCode);
    }, 250); // Delay exit slightly
}

// --- Signal Handling ---
process.on('SIGINT', () => {
    console.log('Received SIGINT (Ctrl+C).');
    gracefulShutdown(0); // Treat SIGINT as a request for graceful exit (code 0)
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM.');
    gracefulShutdown(0); // Treat SIGTERM as a request for graceful exit (code 0)
});

process.on('uncaughtException', (error) => {
    console.error('🚨 Uncaught Exception:', error);
    // Attempt a last-ditch graceful shutdown, might not always work
    gracefulShutdown(1); // Use non-zero exit code for unexpected errors
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
     // Attempt a last-ditch graceful shutdown
    gracefulShutdown(1);
});

// --- Initial Connection ---
connect();

console.log("Agent process started. Waiting for connection...");
