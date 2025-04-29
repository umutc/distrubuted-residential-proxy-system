import WebSocket from 'ws';
import dotenv from 'dotenv';
import { request } from 'undici';
import { setTimeout, clearTimeout } from 'node:timers'; // Explicit Node timers
import { Buffer } from 'node:buffer'; // Explicit Node buffer
import process from 'node:process'; // Explicit Node process
import logger from './logger'; // Import the pino logger

// Load environment variables from .env file
dotenv.config();

const orchestratorUrl = process.env.ORCH_WS;
const agentKey = process.env.AGENT_KEY;
const GRACE_PERIOD_MS = parseInt(process.env.AGENT_GRACE_PERIOD_MS || '10000', 10); // Default 10 seconds

if (!orchestratorUrl || !agentKey) {
  logger.fatal({ errorCode: 'AGT-CFG-1001' }, 'Missing ORCH_WS or AGENT_KEY environment variables. Please ensure a .env file exists in the agent directory with these values.');
  process.exit(1); // Exit code 1 for configuration error
}

// Append agent key as query parameter for authentication
const connectUrl = `${orchestratorUrl}?AGENT_KEY=${encodeURIComponent(agentKey)}`;

logger.info({ orchestratorUrl }, `Attempting to connect to Orchestrator`); // Log without the key

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY_MS = 1000; // 1 second
const MAX_RECONNECT_DELAY_MS = 30 * 1000; // 30 seconds
let reconnectTimeoutId: NodeJS.Timeout | null = null;
let pingIntervalId: NodeJS.Timeout | null = null; // For heartbeat
const PING_INTERVAL_MS = 30 * 1000; // 30 seconds
let statusUpdateIntervalId: NodeJS.Timeout | null = null; // For status updates
const STATUS_UPDATE_INTERVAL_MS = 60 * 1000; // 60 seconds
const agentStartTime = Date.now(); // Record agent start time
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

// --- Agent Status Update Message ---
interface AgentStatusUpdateData {
    status: 'connected' | 'shutting_down'; // Agent's perspective
    activeJobCount: number;
    uptimeSeconds: number;
    platform?: string;
    nodeVersion?: string;
}

interface AgentStatusUpdateMessage extends BaseMessage {
    action: 'agent_status_update';
    data: AgentStatusUpdateData;
}

function connect() {
  if (isShuttingDown) {
      logger.info("Shutdown in progress, connection aborted.");
      return;
  }
  if (reconnectTimeoutId) {
    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
  }
  isClosingGracefully = false; // Reset flag on new connection attempt
  logger.info('Initiating WebSocket connection...');
  ws = new WebSocket(connectUrl);

  ws.on('open', () => {
    logger.info('✅ Connected to Orchestrator.');
    reconnectAttempts = 0; // Reset attempts on successful connection
    startPing(); // Start heartbeat on successful connection
    startStatusUpdates(); // Start periodic status updates
  });

  ws.on('message', (data) => {
    if (isShuttingDown) {
        logger.info("Received message during shutdown, ignoring.");
        return; // Ignore messages during shutdown phase
    }
    try {
      const message: BaseMessage = JSON.parse(data.toString());
      logger.info({ action: message.action, requestId: message.requestId }, `📩 Received action`);

      // Simple message router
      switch (message.action) {
        case 'pong':
          handlePong(message as PongMessage);
          break;
        case 'job_request':
          handleJobRequest(message as JobRequestMessage); // Async handling needed
          break;
        default:
          logger.warn({ action: message.action }, `Unknown action received`);
      }
    } catch (error: any) {
      logger.error({ errorCode: 'AGT-UNK-1000', error: error.message, stack: error.stack, rawMessage: data.toString() }, 'Error parsing or handling incoming WebSocket message');
    }
  });

  ws.on('close', (code, reason) => {
    const reasonString = reason.toString() || 'No reason provided';
    logger.info({ code, reason: reasonString }, `❌ Disconnected from Orchestrator.`);
    stopPing(); // Stop heartbeat on disconnect
    stopStatusUpdates(); // Stop status updates on disconnect
    ws = null;
    // Reconnect only if not shutting down intentionally (gracefully or due to max attempts)
    if (!isClosingGracefully && !isShuttingDown && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        attemptReconnect();
    } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
         logger.error({ errorCode: 'AGT-NET-1003', attempts: MAX_RECONNECT_ATTEMPTS }, `Max reconnect attempts reached. Not attempting further connections.`);
         // Optionally exit or notify
         // gracefulShutdown(1); // Consider triggering shutdown if reconnect fails permanently
    }
  });

  ws.on('error', (error) => {
    logger.error({ errorCode: 'AGT-NET-1001', error: error.message, stack: error.stack }, 'WebSocket Error during connection or operation');
    stopPing(); // Stop ping on error too
    stopStatusUpdates(); // Stop status updates on error too
    // Attempt to close cleanly, the 'close' event will handle reconnect logic
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        logger.info('Closing WebSocket due to error.');
        ws.close(1011, "WebSocket Error"); // Use appropriate code if needed
    }
    // Note: The 'close' event handler should trigger the reconnect logic if appropriate
  });
}

function attemptReconnect() {
    if (isShuttingDown) {
        logger.info("Shutdown in progress, reconnect aborted.");
        return;
    }
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        logger.error({ errorCode: 'AGT-NET-1003', maxAttempts: MAX_RECONNECT_ATTEMPTS }, `Max reconnect attempts reached. Giving up.`);
        gracefulShutdown(1); // Trigger shutdown if reconnect fails permanently
        return;
    }

    reconnectAttempts++;
    // Exponential backoff with jitter
    const delay = Math.min(
        INITIAL_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1) + Math.random() * 1000,
        MAX_RECONNECT_DELAY_MS
    );

    logger.info({ attempt: reconnectAttempts, maxAttempts: MAX_RECONNECT_ATTEMPTS, delaySeconds: Math.round(delay / 1000) }, `Attempting reconnection`);

    reconnectTimeoutId = setTimeout(() => {
        connect();
    }, delay);
}

// --- Heartbeat (Ping/Pong) ---
function startPing() {
    stopPing(); // Clear existing interval if any
    logger.info({ intervalMs: PING_INTERVAL_MS }, `Starting heartbeat ping`);
    pingIntervalId = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN && !isShuttingDown) {
            const pingMsg: PingMessage = {
                action: 'ping',
                timestamp: Date.now(),
                // requestId: uuidv4() // Add request ID if needed for tracking pongs
            };
            logger.debug(`	💓 Sending ping...`); // Use debug for frequent messages
            sendMessage(pingMsg); // Use sendMessage for consistency
        } else if (isShuttingDown) {
             logger.info('Not sending ping, shutdown in progress.');
             stopPing(); // Stop pinging during shutdown
        } else {
            logger.warn('Cannot send ping, WebSocket not open or shutting down.');
            // Connection might be closing or already closed, reconnect logic will handle it.
        }
    }, PING_INTERVAL_MS);
}

function stopPing() {
    if (pingIntervalId) {
        logger.info('Stopping heartbeat ping.');
        clearInterval(pingIntervalId);
        pingIntervalId = null;
    }
}

function handlePong(message: PongMessage) {
    // Only log if not shutting down, less noise
    if (!isShuttingDown) {
        const latency = message.timestamp ? Date.now() - Number(message.timestamp) : undefined;
        logger.debug({ latencyMs: latency }, `	💓 Received pong.`); // Use debug
    }
    // Optionally track latency or confirm connection is alive
}

// --- Agent Status Update Logic ---
function startStatusUpdates() {
    stopStatusUpdates(); // Clear existing interval first
    logger.info({ intervalMs: STATUS_UPDATE_INTERVAL_MS }, `Starting periodic agent status updates`);
    statusUpdateIntervalId = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN && !isShuttingDown) {
            sendAgentStatusUpdate('connected');
        } else {
            logger.warn('Cannot send status update, WebSocket not open or shutting down.');
            // If WS is not open, the interval will be stopped by close/error handlers anyway
        }
    }, STATUS_UPDATE_INTERVAL_MS);
    // Send initial status immediately on connect
    sendAgentStatusUpdate('connected');
}

function stopStatusUpdates() {
    if (statusUpdateIntervalId) {
        logger.info('Stopping periodic agent status updates.');
        clearInterval(statusUpdateIntervalId);
        statusUpdateIntervalId = null;
    }
}

function sendAgentStatusUpdate(currentStatus: 'connected' | 'shutting_down') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        logger.warn({ targetStatus: currentStatus }, 'Cannot send status update, WebSocket not open.');
        return;
    }

    const statusData: AgentStatusUpdateData = {
        status: currentStatus,
        activeJobCount: activeJobs.size,
        uptimeSeconds: Math.round((Date.now() - agentStartTime) / 1000),
        platform: process.platform,
        nodeVersion: process.version,
    };

    const statusMessage: AgentStatusUpdateMessage = {
        action: 'agent_status_update',
        timestamp: Date.now(),
        data: statusData,
    };
    logger.debug({ statusData }, 'Sending agent status update');
    sendMessage(statusMessage);
}

// --- Job Handling ---

// Make handleJobRequest async as executeHttpRequest is async
async function handleJobRequest(message: JobRequestMessage) {
    // 1. Check if shutting down
    if (isShuttingDown) {
      logger.warn({ jobId: message.data?.jobId, requestId: message.requestId }, `Received job request during shutdown, rejecting.`);
      // Use specific error code from docs/error-codes.md
      sendErrorResponse(message.requestId, message.data?.jobId, 'Agent is shutting down', 'AGT-SHT-1001'); 
      return;
    }

    logger.info({ jobId: message.data?.jobId, requestId: message.requestId, url: message.data?.url, method: message.data?.method }, `Received job request`);

    // --- Robust Validation ---
    if (!message.data) {
        logger.error({ requestId: message.requestId, errorCode: 'AGT-VAL-1001' }, 'Invalid job request: Missing data field.');
        sendErrorResponse(message.requestId, undefined, 'Invalid job request: Missing data field', 'AGT-VAL-1001');
        return;
    }

    const { jobId, url, method, headers, body, bodyEncoding, timeoutMs } = message.data;

    // Basic validation (keep concise for example)
    if (!jobId || !url || !method) {
         logger.warn({ jobId, requestId: message.requestId, errorCode: 'AGT-VAL-1001' }, 'Invalid job request: Missing required fields (jobId, url, method)');
         sendErrorResponse(message.requestId, jobId, 'Invalid job request: Missing required fields (jobId, url, method)', 'AGT-VAL-1001');
         return;
    }
     try {
        new URL(url); // Basic URL format check
    } catch (e) {
        logger.warn({ jobId, url, requestId: message.requestId, errorCode: 'AGT-VAL-1001' }, 'Invalid job request: Malformed URL');
        sendErrorResponse(message.requestId, jobId, 'Invalid job request: Malformed URL', 'AGT-VAL-1001');
        return;
    }
     if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
        logger.warn({ jobId, method, requestId: message.requestId, errorCode: 'AGT-VAL-1001' }, `Invalid job request: Invalid method`);
        sendErrorResponse(message.requestId, jobId, `Invalid job request: Invalid method: ${method}`, 'AGT-VAL-1001');
        return;
    }
    // Add other validations as needed...
    // --- End Validation ---

    // 2. Add job to active set *before* execution
    activeJobs.add(jobId);
    logger.info({ jobId, activeJobCount: activeJobs.size }, `Job added to active set.`);

    try {
        let requestBody: Buffer | string | undefined = undefined;
        if (body) {
            if (bodyEncoding === 'base64') {
                try {
                    requestBody = Buffer.from(body, 'base64');
                } catch (e: any) {
                    // Cannot return here directly, need to go to finally block to remove from activeJobs
                    // Throw an error instead to be caught by the outer catch block
                    logger.error({ jobId, error: e.message, requestId: message.requestId, errorCode: 'AGT-JOB-1003' }, 'Failed to decode base64 body');
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        let errorCode = 'AGT-UNK-1000'; // Default unknown error
        if (errorMessage.includes('Failed to decode base64 body')) {
             errorCode = 'AGT-JOB-1003';
        }
        logger.error({ jobId, error: errorMessage, errorCode, requestId: message.requestId }, `Error during job request handling or setup`);
        // Ensure an error response is sent IF executeHttpRequest wasn't the source of the error
        // (executeHttpRequest sends its own errors)
        // Check if the error originated from our setup phase
        if (!(error instanceof Error && error.message.startsWith('Failed executing HTTP request'))) { // Heuristic check
             sendErrorResponse(message.requestId, jobId, `Internal agent error during job setup: ${errorMessage}`, errorCode, 500);
        }
    } finally {
        // 3. Remove job from active set in finally block
        activeJobs.delete(jobId);
        logger.info({ jobId, activeJobCount: activeJobs.size }, `Job removed from active set.`);

        // 4. Check if shutdown is pending and this was the last job
        if (isShuttingDown && activeJobs.size === 0) {
            logger.info('Last active job completed during shutdown.');
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
    logger.info({ jobId, method, url, requestId }, `Executing HTTP request`);
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

        logger.info({ jobId, statusCode, requestId }, `Received response from target`);

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
        // Default error code
        let errorCode = 'AGT-JOB-1000'; // General job execution failure
        let message = `Failed executing HTTP request: Unknown error`;
        let statusCode: number | undefined = undefined; // HTTP status from error if available

        // Log the raw error first for debugging
        logger.error({ jobId, rawError: error, errorCode: 'RAW_HTTP_EXEC_ERROR', requestId }, `Raw error during HTTP request execution`);

        // --- Map common error scenarios to specific codes --- 
        if (error && typeof error === 'object') {
             // undici specific errors often have codes
            if ('code' in error) {
                message = `${error.code} - ${error.message}`;
                if (error.code === 'UND_ERR_CONNECT_TIMEOUT') { // Note: connectTimeout is implicit in headersTimeout usually
                    errorCode = 'AGT-NET-1005'; 
                } else if (error.code === 'UND_ERR_HEADERS_TIMEOUT' || error.code === 'UND_ERR_BODY_TIMEOUT') {
                    errorCode = 'AGT-JOB-1001';
                } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
                     errorCode = 'AGT-NET-1006';
                } // Add more specific undici error codes if needed
            } else {
                 message = `${error.message || 'Unknown error'}`;
            }
             // Check if it resembles an HTTP error structure from undici or target
            if ('statusCode' in error && typeof error.statusCode === 'number') {
                statusCode = error.statusCode;
                errorCode = 'AGT-JOB-1002'; // Use this for any target response error
                message = `${error.message || 'Unknown error'}`;
            } else if ('response' in error && error.response && 'statusCode' in error.response && typeof error.response.statusCode === 'number') {
                // Handle cases where undici wraps the response in error
                statusCode = error.response.statusCode;
                errorCode = 'AGT-JOB-1002';
                message = `${error.message || 'Unknown error'}`;
            }
        } else {
            message = `${String(error)}`;
        }

        // Cast error to unknown when passing as details
        // Log the specific error details being sent back
        logger.warn({ jobId, errorCode, message, statusCode: statusCode, details: error as unknown, requestId }, "Sending error response for HTTP request failure");
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
    logger.info({ jobId, targetStatusCode: statusCode, requestId }, `Success response sent`);
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
     logger.error({ jobId: effectiveJobId, errorCode, message, statusCode, requestId }, `Error response sent`);
}

function sendMessage(message: BaseMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch (error: any) {
      logger.error({ action: message.action, error: error.message, errorCode: 'AGT-NET-1004' }, 'Error sending message via WebSocket');
      // Attempt to close connection if send fails, reconnect logic will handle it
       if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close(1011, "Send Error");
       }
    }
  } else {
    logger.warn({ action: message.action }, `Cannot send message, WebSocket not open.`);
    // Don't attempt reconnect here, let the close/error handlers manage it
  }
}

// --- Graceful Shutdown Logic ---
function gracefulShutdown(exitCode: number = 0) {
    if (isShuttingDown) {
        logger.info('Shutdown already in progress.');
        return; // Prevent redundant shutdown calls
    }
    isShuttingDown = true;
    logger.info({ exitCode }, `🚨 Initiating graceful shutdown...`);
    stopPing(); // Stop sending pings
    stopStatusUpdates(); // Stop periodic updates

    // Send final status update indicating shutdown
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendAgentStatusUpdate('shutting_down');
    }

    if (reconnectTimeoutId) {
        clearTimeout(reconnectTimeoutId); // Cancel any pending reconnect
        reconnectTimeoutId = null;
    }

    if (activeJobs.size === 0) {
        logger.info('No active jobs. Shutting down immediately.');
        closeConnectionAndExit(exitCode);
    } else {
        logger.info({ jobCount: activeJobs.size, gracePeriodSec: GRACE_PERIOD_MS / 1000 }, `Waiting for active jobs to complete...`);
        logger.info({ activeJobIds: Array.from(activeJobs) }, 'Active job IDs');

        // Set a timer to force exit if jobs don't finish
        shutdownTimeoutId = setTimeout(() => {
            logger.warn({ gracePeriodSec: GRACE_PERIOD_MS / 1000 }, `Grace period expired. Forcing shutdown.`);
            logger.warn({ activeJobIds: Array.from(activeJobs) }, `Jobs still active`);
            closeConnectionAndExit(1); // Use non-zero exit code for forced shutdown
        }, GRACE_PERIOD_MS);
    }
}

function closeConnectionAndExit(exitCode: number) {
     logger.info({ exitCode }, `Closing WebSocket connection and exiting...`);
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
        logger.info({ exitCode }, "Exiting process.");
        process.exit(exitCode);
    }, 250); // Delay exit slightly
}

// --- Global Error Handlers ---
process.on('uncaughtException', (error) => {
    logger.fatal({ 
        errorCode: 'AGT-UNK-1001',
        errorName: error.name,
        errorMessage: error.message, 
        stack: error.stack 
    }, '🚨 Uncaught Exception'); // Use fatal for critical errors
    // Attempt a last-ditch graceful shutdown, might not always work
    gracefulShutdown(1); // Use non-zero exit code for unexpected errors
});

process.on('unhandledRejection', (reason, promise) => {
    let errorDetails: any = reason;
    // Attempt to extract more details if reason is an Error object
    if (reason instanceof Error) {
        errorDetails = {
            name: reason.name,
            message: reason.message,
            stack: reason.stack
        };
    }
    logger.fatal({ 
        errorCode: 'AGT-UNK-1002',
        reason: errorDetails, // Log extracted details or original reason
        promise 
    }, '🚨 Unhandled Rejection'); // Use fatal
     // Attempt a last-ditch graceful shutdown
    gracefulShutdown(1);
});

// --- Signal Handlers for Graceful Exit ---
process.on('SIGINT', () => {
    logger.info('Received SIGINT signal.');
    gracefulShutdown(0);
});

process.on('SIGTERM', () => {
    logger.info('Received SIGTERM signal.');
    gracefulShutdown(0);
});

// --- Initial Connection ---
connect();

logger.info("Agent process started. Waiting for connection...");
