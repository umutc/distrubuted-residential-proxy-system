import * as client from 'prom-client';

// Create a Registry which registers the metrics
export const register = new client.Registry();

// Enable the collection of default metrics
client.collectDefaultMetrics({ register });

// --- Custom Agent Metrics ---

// Gauge for WebSocket connection status
export const connectionStatusGauge = new client.Gauge({
  name: 'agent_websocket_connection_status',
  help: 'WebSocket connection status (1 = connected, 0 = disconnected)',
  registers: [register],
});

// Counter for jobs received
export const jobsReceivedCounter = new client.Counter({
  name: 'agent_jobs_received_total',
  help: 'Total number of jobs received from the orchestrator',
  registers: [register],
});

// Counter for jobs processed (by status)
export const jobsProcessedCounter = new client.Counter({
  name: 'agent_jobs_processed_total',
  help: 'Total number of jobs processed, labeled by status',
  labelNames: ['status'], // 'success', 'error'
  registers: [register],
});

// Histogram for job execution duration
export const jobDurationHistogram = new client.Histogram({
  name: 'agent_job_execution_duration_seconds',
  help: 'Duration of job execution in seconds',
  labelNames: ['method', 'status_code'],
  // Buckets for response time from 1ms to 30 seconds
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

// Counter for HTTP request errors during job execution
export const jobHttpRequestErrorCounter = new client.Counter({
  name: 'agent_job_http_request_errors_total',
  help: 'Total number of HTTP request errors during job execution',
  labelNames: ['error_code'], // e.g., 'ECONNREFUSED', 'TIMEOUT', 'HTTP_500'
  registers: [register],
});

// Gauge for current agent status (available/busy)
export const agentStatusGauge = new client.Gauge({
  name: 'agent_status',
  help: 'Current agent status (1 = available, 0 = busy)',
  registers: [register],
});

// Gauge for current memory usage (using custom collect)
export const memoryUsageGauge = new client.Gauge({
  name: 'agent_memory_usage_bytes',
  help: 'Current memory usage of the agent process in bytes',
  collect() {
    // This function is invoked when metrics are scraped
    this.set(process.memoryUsage().rss);
  },
  registers: [register],
});

// You can add more metrics as needed, e.g.,
// - Gauge for number of active connections (if the agent manages multiple)
// - Counter for specific application errors

console.log('Prometheus metrics initialized.');

// --- Agent Specific Metrics ---

// Counter for errors encountered during job processing
export const jobErrorsCounter = new client.Counter({
  name: 'agent_job_errors_total',
  help: 'Total number of errors encountered during job processing',
  labelNames: ['error_code', 'status_code'], // e.g., 'TARGET_TIMEOUT', '504' or 'DECODE_ERROR', '400'
  registers: [register],
});

// Gauge for currently active jobs
export const activeJobsGauge = new client.Gauge({
  name: 'agent_active_jobs',
  help: 'Number of jobs currently being processed by the agent',
  registers: [register],
});

// Histogram for target request duration
export const targetRequestDurationHistogram = new client.Histogram({
  name: 'agent_target_request_duration_seconds',
  help: 'Duration of HTTP requests made to the target URL',
  labelNames: ['method', 'status_code'], // e.g., 'GET', '200'
  // Buckets in seconds, e.g., 0.1s, 0.5s, 1s, 2s, 5s, 10s, 30s
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

// Counter for WebSocket connection errors
export const websocketErrorsCounter = new client.Counter({
  name: 'agent_websocket_errors_total',
  help: 'Total number of WebSocket errors encountered',
  labelNames: ['type'], // e.g., 'connect_failed', 'unexpected_disconnect', 'send_error'
  registers: [register],
});

// --- Metrics Server (Optional - can be exposed via a separate endpoint later) ---
// Basic setup example (commented out for now, will be part of subtask 10.13)
/*
import * as http from 'http';

export const startMetricsServer = (port: number = 9090) => {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      try {
        res.setHeader('Content-Type', register.contentType);
        res.end(await register.metrics());
      } catch (ex: any) {
        res.writeHead(500).end(ex.message);
      }
    } else {
      res.writeHead(404).end('Not Found');
    }
  });

  server.listen(port, () => {
    console.log(`Metrics server listening on port ${port}`);
  });

  return server;
};
*/

// Function to safely get metrics string (avoids potential async issues if called directly in some contexts)
export const getMetrics = async (): Promise<string> => {
  return register.metrics();
}; 