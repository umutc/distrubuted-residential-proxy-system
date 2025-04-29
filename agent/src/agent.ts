import WebSocket from 'ws';
import dotenv from 'dotenv';
import { setTimeout, clearTimeout } from 'node:timers'; // Explicit Node timers
import { Buffer } from 'node:buffer'; // Explicit Node buffer
import process from 'node:process'; // Explicit Node process
import http from 'node:http'; // Import HTTP module
import logger from './logger'; // Corrected path: logger is in the same directory (src)
import {
  register,
  connectionStatusGauge,
  jobsReceivedCounter,
  jobsProcessedCounter,
  jobDurationHistogram,
  jobHttpRequestErrorCounter,
  agentStatusGauge,
  memoryUsageGauge,
  jobErrorsCounter,
  activeJobsGauge,
  websocketErrorsCounter,
} from './utils/metrics';
import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import { AgentConfig, JobRequestPayload, JobResponsePayload, ErrorResponsePayload } from './types'; // Corrected path: types.ts is now in the same directory (src)
import { generateRequestId } from './utils/requestId'; // CORRECTED PATH AGAIN
import { getAgentId } from './utils/agentId'; // CORRECTED PATH AGAIN

// Load environment variables from .env file
dotenv.config();

const orchestratorUrl = process.env.ORCH_WS;
const agentKey = process.env.AGENT_KEY;
const GRACE_PERIOD_MS = parseInt(process.env.AGENT_GRACE_PERIOD_MS || '10000', 10); // Default 10 seconds
const METRICS_PORT = parseInt(process.env.AGENT_METRICS_PORT || '9091', 10); // Add metrics port

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

// --- Message Interfaces (Consistently use 'type') ---
interface BaseMessage {
    type: string; // Changed from action
    requestId?: string; // Optional request ID for tracking
    timestamp?: number | string;
}

interface PingMessage extends BaseMessage {
    type: 'ping'; // Changed from action
    // data?: any; // Optional data for ping - Removed for simplicity unless needed
}

interface PongMessage extends BaseMessage {
    type: 'pong'; // Changed from action
    receivedTimestamp?: number; // Use specific field for clarity
}

// Job request uses JobRequestPayload from types.ts
interface JobRequest extends BaseMessage {
    type: 'job_request';
    payload: JobRequestPayload;
}

// Job response uses JobResponsePayload from types.ts
interface JobResponse extends BaseMessage {
    type: 'job_response';
    jobId: string; // Keep jobId directly on response for easier routing/logging
    payload: JobResponsePayload;
}

// Error response uses ErrorResponsePayload from types.ts
interface ErrorResponse extends BaseMessage {
    type: 'error_response';
    jobId: string; // Keep jobId directly on response
    payload: ErrorResponsePayload;
}

// Agent status update
interface AgentStatusUpdatePayload {
    status: 'connected' | 'shutting_down'; // Agent's perspective
    activeJobCount: number;
    uptimeSeconds: number;
    platform?: string;
    nodeVersion?: string;
}

interface AgentStatusUpdateMessage extends BaseMessage {
    type: 'agent_status_update'; // Changed from action
    payload: AgentStatusUpdatePayload;
}

// Union type for messages handled by the agent
type AgentMessage =
    | PingMessage
    | PongMessage
    | JobRequest
    | AgentStatusUpdateMessage
    | JobResponse // Included for potential future two-way communication
    | ErrorResponse; // Included for potential future two-way communication

// Union type for messages sent by the agent
type SentMessage = PingMessage | AgentStatusUpdateMessage | JobResponse | ErrorResponse;

// --- Metrics Server Setup ---
const metricsServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/metrics') {
    try {
      res.setHeader('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (ex: any) {
      logger.error({ errorCode: 'AGT-MET-1001', error: ex.message, stack: ex.stack }, 'Error serving metrics');
      res.writeHead(500).end(ex.message);
    }
  } else {
    res.writeHead(404).end('Not Found');
  }
});

metricsServer.listen(METRICS_PORT, () => {
  logger.info({ port: METRICS_PORT }, `📊 Metrics server listening on port`);
});

metricsServer.on('error', (err) => {
    logger.error({ errorCode: 'AGT-MET-1002', error: err.message, stack: err.stack }, 'Metrics server error');
});
// --- End Metrics Server Setup ---

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
    connectionStatusGauge.set(1); // CORRECTED: Use connectionStatusGauge
    reconnectAttempts = 0;
    startPing();
    startStatusUpdates();
  });

  ws.on('message', (data) => {
    if (isShuttingDown) {
        logger.info("Received message during shutdown, ignoring.");
        return; // Ignore messages during shutdown phase
    }
    try {
      // Use the AgentMessage union type for better type safety
      const message: AgentMessage = JSON.parse(data.toString());
      logger.info({ type: message.type, requestId: message.requestId }, `📩 Received type`); // Log type instead of action

      // Simple message router based on 'type'
      switch (message.type) {
        case 'pong':
          handlePong(message as PongMessage);
          break;
        case 'job_request':
          handleJobRequest(message as JobRequest); // Async handling needed
          break;
        // Add cases for other message types the agent might receive if needed
        default:
          // Use exhaustive check pattern (requires tweaking types if not all message types are handled)
          // const _exhaustiveCheck: never = message;
          logger.warn({ type: (message as any).type }, `Unknown message type received`);
          websocketErrorsCounter.inc({ type: 'unknown_message_type' });
      }
    } catch (error: any) {
      logger.error({ errorCode: 'AGT-UNK-1000', error: error.message, stack: error.stack, rawMessage: data.toString() }, 'Error parsing or handling incoming WebSocket message');
      websocketErrorsCounter.inc({ type: 'Message Handling' }); // Increment WebSocket error counter for handling issues
    }
  });

  ws.on('close', (code, reason) => {
    const reasonString = reason.toString() || 'No reason provided';
    logger.info({ code, reason: reasonString }, `❌ Disconnected from Orchestrator.`);
    stopPing();
    stopStatusUpdates();
    ws = null;
    connectionStatusGauge.set(0); // CORRECTED: Use connectionStatusGauge

    if (!isClosingGracefully && !isShuttingDown && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        attemptReconnect();
    } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
         logger.error({ errorCode: 'AGT-NET-1003', attempts: MAX_RECONNECT_ATTEMPTS }, `Max reconnect attempts reached. Not attempting further connections.`);
    }
  });

  ws.on('error', (error) => {
    logger.error({ errorCode: 'AGT-NET-1001', error: error.message, stack: error.stack }, 'WebSocket Error during connection or operation');
    websocketErrorsCounter.inc({ type: 'WebSocket Operation' });
    stopPing();
    stopStatusUpdates();
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        logger.info('Closing WebSocket due to error.');
        connectionStatusGauge.set(0); // CORRECTED: Use connectionStatusGauge
        ws.close(1011, "WebSocket Error");
    } else {
        connectionStatusGauge.set(0); // CORRECTED: Ensure gauge is 0 if already closed
    }
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
                type: 'ping',
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
        const latency = message.receivedTimestamp ? Date.now() - Number(message.receivedTimestamp) : undefined;
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

    const statusPayload: AgentStatusUpdatePayload = {
        status: currentStatus,
        activeJobCount: activeJobs.size,
        uptimeSeconds: Math.round((Date.now() - agentStartTime) / 1000),
        platform: process.platform,
        nodeVersion: process.version,
    };

    const statusMessage: AgentStatusUpdateMessage = {
        type: 'agent_status_update', // Changed from action
        timestamp: Date.now(),
        payload: statusPayload,
    };
    logger.debug({ statusPayload }, 'Sending agent status update');
    sendMessage(statusMessage);
}

// --- Job Handling ---

// Make handleJobRequest async as executeHttpRequest is async
async function handleJobRequest(message: JobRequest) { // Use JobRequest type
  const { payload, requestId = generateRequestId() } = message;
  const { jobId } = payload;

  logger.info({ jobId, requestId }, `Received job request`);
  jobsReceivedCounter.inc(); // Increment jobs received counter
  activeJobsGauge.inc(); // Increment active jobs gauge
  agentStatusGauge.set(0); // Set agent status to busy

  // Track the active job ID
  activeJobs.add(jobId);

  const jobTimerEnd = jobDurationHistogram.startTimer(); // Start job duration timer

  try {
    // Pass the entire payload to executeHttpRequest
    const response: AxiosResponse<Buffer> = await executeHttpRequest(
      payload, // Pass the full payload object
      requestId,
      jobId
    );

    // Success
    sendSuccessResponse(jobId, response, requestId);
    jobsProcessedCounter.labels('success').inc(); // Increment success counter
    jobTimerEnd({ method: payload.method, status_code: response.status }); // Observe duration

  } catch (error: any) {
    let errorCode = 'AGT-JOB-1001'; // Default job execution error
    let errorMessage = 'Job execution failed';
    let httpStatusCode: number | null = null;

    // Log HTTP request errors with specific label
    if (axios.isAxiosError(error)) {
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            httpStatusCode = error.response.status;
            errorMessage = `Target server responded with error: ${httpStatusCode}`;
            errorCode = `HTTP_${httpStatusCode}`;
            jobHttpRequestErrorCounter.labels({ error_code: errorCode }).inc();
        } else if (error.request) {
            // The request was made but no response was received
            errorMessage = 'No response received from target server';
            errorCode = error.code || 'NO_RESPONSE'; // e.g., ECONNREFUSED, ETIMEDOUT
            jobHttpRequestErrorCounter.labels({ error_code: errorCode }).inc();
        } else {
            // Something happened in setting up the request that triggered an Error
            errorMessage = `Request setup error: ${error.message}`;
            errorCode = 'REQUEST_SETUP_ERROR';
            jobHttpRequestErrorCounter.labels({ error_code: errorCode }).inc();
        }
    } else {
        // Non-axios error during execution
        errorMessage = `Unexpected error during job execution: ${error.message}`;
        errorCode = 'UNEXPECTED_EXECUTION_ERROR';
        jobHttpRequestErrorCounter.labels({ error_code: errorCode }).inc(); // Use generic code
    }

    logger.error({ jobId, requestId, errorCode, errorMessage, error: error.message, stack: error.stack }, 'Job execution failed');
    sendErrorResponse(jobId, errorCode, errorMessage, httpStatusCode, requestId);
    jobsProcessedCounter.labels('error').inc(); // Increment error counter
    jobErrorsCounter.labels({ error_code: errorCode, status_code: httpStatusCode ?? 'N/A' }).inc(); // Also log to the specific jobErrorsCounter
    // Observe duration even on error, potentially label differently?
    jobTimerEnd({ method: payload.method, status_code: httpStatusCode ?? 'error' }); // Use 'error' or actual code

  } finally {
    // Ensure job ID is removed and gauges are updated regardless of success/failure
    activeJobs.delete(jobId);
    activeJobsGauge.dec(); // Decrement active jobs gauge
    // Set agent status back to available only if no other jobs are active
    if (activeJobs.size === 0) {
      agentStatusGauge.set(1);
    }
  }
}

async function executeHttpRequest(
    requestPayload: JobRequestPayload, // Use payload type
    requestId: string,
    jobId: string // Pass jobId explicitly for logging
): Promise<AxiosResponse<Buffer>> { // Return the full AxiosResponse
    const { url, method, headers, body, bodyEncoding, timeoutMs = 30000 } = requestPayload;
    logger.info(`Executing target request for job ${jobId}`, { requestId, url, method, timeoutMs });

    const config: AxiosRequestConfig = {
        url,
        method: method.toUpperCase() as any,
        headers: headers || {},
        timeout: timeoutMs,
        responseType: 'arraybuffer',
        validateStatus: (status) => status >= 100 && status < 600,
    };

    if (body) {
        config.data = (bodyEncoding === 'base64') ? Buffer.from(body, 'base64') : body;
        if (bodyEncoding !== 'base64' && !config.headers?.['Content-Type']) {
            config.headers = { ...config.headers, 'Content-Type': 'text/plain; charset=utf-8' };
        }
    }

    let response: AxiosResponse<Buffer>;
    try {
        response = await axios(config);
        logger.info(`Target request successful for job ${jobId}`, {
            requestId,
            statusCode: response.status,
            responseLength: response.data.length,
        });
    } catch (error: any) {
        jobErrorsCounter.inc({
            error_code: error.code || 'AXIOS_ERROR',
            status_code: (error.response?.status || 500).toString(),
        });
        logger.error(`Target request failed for job ${jobId}`, {
            requestId,
            errorMessage: error.message,
            errorCode: error.code,
            targetStatusCode: error.response?.status,
        });
        throw error; // Re-throw
    }

    return response; // Return the full Axios response
}

// Send a successful job response back to the master
const sendSuccessResponse = (
  jobId: string,
  response: AxiosResponse<Buffer>, // Expect full AxiosResponse<Buffer>
  requestId: string
) => {
    // Determine response encoding: Base64 for binary types, UTF8 otherwise
    const contentType = response.headers['content-type'] || '';
    const isBinary = contentType.startsWith('image/') ||
                     contentType.startsWith('audio/') ||
                     contentType.startsWith('video/') ||
                     contentType === 'application/octet-stream' ||
                     contentType === 'application/pdf' ||
                     contentType === 'application/zip';
    const bodyEncoding = isBinary ? 'base64' : 'utf8';

    const responsePayload: JobResponsePayload = {
        statusCode: response.status,
        headers: response.headers as Record<string, string>, // Assert type
        body: Buffer.from(response.data).toString(bodyEncoding),
        bodyEncoding: bodyEncoding,
    };

    const responseMessage: JobResponse = {
        type: 'job_response', // Changed from action
        jobId,
        requestId,
        payload: responsePayload,
    };
    sendMessage(responseMessage);
    jobsProcessedCounter.inc({ status: 'success' });
    logger.info(`Sent success response for job ${jobId}`, { jobId, statusCode: response.status, requestId });
};

// Send an error response back to the master
const sendErrorResponse = (
  jobId: string,
  errorCode: string,
  errorMessage: string,
  statusCode: number | null,
  requestId: string
) => {
    const errorPayload: ErrorResponsePayload = {
        errorCode,
        errorMessage,
        statusCode: statusCode || undefined,
    };

    const errorResponseMessage: ErrorResponse = {
        type: 'error_response', // Changed from action
        jobId,
        requestId,
        payload: errorPayload,
    };
    jobsProcessedCounter.inc({ status: 'failed' });
    jobErrorsCounter.inc({ error_code: errorCode, status_code: String(statusCode || 'N/A') });
    sendMessage(errorResponseMessage);
    logger.warn(`Sent error response for job ${jobId}: ${errorCode}`, { jobId, errorCode, errorMessage, statusCode, requestId });
};

// Helper function to send messages, handles potential null ws
// Uses the SentMessage union type for better type safety
const sendMessage = (message: SentMessage) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch (error: any) {
      // Use message.type now
      logger.error(
        { messageType: message.type, jobId: (message as any).jobId, requestId: message.requestId, error: error.message, stack: error.stack },
        'Failed to send message via WebSocket'
      );
      websocketErrorsCounter.inc({ type: 'send_error' });
    }
  } else {
    // Use message.type now
    logger.error(
      { messageType: message.type, jobId: (message as any).jobId, requestId: message.requestId },
      'WebSocket not open. Cannot send message.'
    );
    websocketErrorsCounter.inc({ type: 'send_error_not_open' });
    // Potentially queue message or handle error differently
  }
};

// --- Graceful Shutdown Logic ---
function gracefulShutdown(exitCode: number = 0) {
    if (isShuttingDown) {
        logger.warn('Graceful shutdown already in progress.');
        return; // Avoid duplicate shutdowns
    }
    isShuttingDown = true;
    logger.info({ exitCode }, `Initiating graceful shutdown...`);

    // Stop accepting new connections/work immediately
    isClosingGracefully = true; // Prevent immediate reconnect attempts
    stopPing();
    stopStatusUpdates();
    // Update status gauge if needed (e.g., to a specific shutdown state)
    // connectionStatusGauge.set(-1); // Example: Set to -1 during shutdown

    // Send shutdown notification to orchestrator
    sendAgentStatusUpdate('shutting_down');

    const shutdownAction = () => {
        logger.info("Grace period ended or no active jobs. Closing connection.");
        closeConnectionAndExit(exitCode);
    };

    if (activeJobs.size > 0) {
        logger.info({ activeJobCount: activeJobs.size, gracePeriodMs: GRACE_PERIOD_MS }, `Waiting for active jobs to complete...`);
        // Set a timeout for the grace period
        shutdownTimeoutId = setTimeout(() => {
            logger.warn({ gracePeriodMs: GRACE_PERIOD_MS }, 'Grace period expired. Forcing shutdown.');
            // Force close potentially interrupting jobs
            shutdownAction();
        }, GRACE_PERIOD_MS);
        // We rely on the finally block of handleJobRequest to call shutdownAction when activeJobs.size becomes 0
    } else {
        logger.info('No active jobs. Proceeding with immediate shutdown.');
        shutdownAction();
    }
}

function closeConnectionAndExit(exitCode: number) {
    if (shutdownTimeoutId) {
        clearTimeout(shutdownTimeoutId);
        shutdownTimeoutId = null;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      logger.info('Closing WebSocket connection before exiting...');
      isClosingGracefully = true; // Ensure flag is set
      connectionStatusGauge.set(0); // CORRECTED: Set gauge to 0 on final close
      ws.close(1000, 'Agent shutting down gracefully'); // Normal closure
    }
    logger.info({ exitCode }, `Exiting agent process.`);
    // Close metrics server gracefully
    metricsServer.close(() => {
      logger.info('Metrics server closed.');
      process.exit(exitCode);
    });
    // Force exit if metrics server doesn't close quickly
    setTimeout(() => {
        logger.warn('Metrics server close timeout exceeded. Forcing exit.');
        process.exit(exitCode);
    }, 2000); // 2 second timeout
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
