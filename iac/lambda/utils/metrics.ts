import * as client from 'prom-client';

// Create a Registry for Orchestrator metrics
// We might need a way to aggregate metrics across Lambda invocations
// (e.g., using Redis, a dedicated metrics service, or CloudWatch Exporter).
// For now, define the metrics structure.
export const register = new client.Registry();

// Enable the collection of default metrics (useful if run in a persistent environment, might be less useful for ephemeral Lambdas)
// client.collectDefaultMetrics({ register });

// --- Orchestrator Specific Metrics ---

// Agent Connection Metrics
export const connectedAgentsGauge = new client.Gauge({
  name: 'orchestrator_connected_agents_total',
  help: 'Total number of agents currently connected via WebSocket',
  registers: [register],
});

export const availableAgentsGauge = new client.Gauge({
  name: 'orchestrator_available_agents_total',
  help: 'Number of connected agents currently marked as available',
  registers: [register],
});

export const busyAgentsGauge = new client.Gauge({
  name: 'orchestrator_busy_agents_total',
  help: 'Number of connected agents currently marked as busy',
  registers: [register],
});

// Job Processing Metrics
export const jobsReceivedCounter = new client.Counter({
  name: 'orchestrator_jobs_received_total',
  help: 'Total number of jobs received by the ingestion API',
  registers: [register],
});

export const jobsDistributedCounter = new client.Counter({
  name: 'orchestrator_jobs_distributed_total',
  help: 'Total number of jobs successfully sent to an agent',
  registers: [register],
});

export const jobsCompletedCounter = new client.Counter({
  name: 'orchestrator_jobs_completed_total',
  help: 'Total number of jobs completed, labeled by final status',
  labelNames: ['status'], // e.g., 'success', 'failed', 'timeout'
  registers: [register],
});

// Error Counters
export const jobDistributionErrorsCounter = new client.Counter({
  name: 'orchestrator_job_distribution_errors_total',
  help: 'Total number of errors during job distribution (e.g., no agent available, send failed)',
  labelNames: ['reason'], // e.g., 'no_agent_available', 'websocket_send_failed'
  registers: [register],
});

export const jobResponseHandlingErrorsCounter = new client.Counter({
  name: 'orchestrator_job_response_handling_errors_total',
  help: 'Total number of errors processing responses from agents',
  labelNames: ['reason'], // e.g., 'invalid_response_format', 'job_not_found'
  registers: [register],
});

// API Metrics
export const apiRequestsCounter = new client.Counter({
    name: 'orchestrator_api_requests_total',
    help: 'Total number of requests to the orchestrator API',
    labelNames: ['endpoint', 'method', 'status_code'],
    registers: [register],
});

export const apiRequestDurationHistogram = new client.Histogram({
    name: 'orchestrator_api_request_duration_seconds',
    help: 'Duration of requests to the orchestrator API',
    labelNames: ['endpoint', 'method'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], // Example buckets
    registers: [register],
});

// Queue Metrics (Example - Actual implementation might require CloudWatch integration)
// export const jobInputQueueDepthGauge = new client.Gauge({
//   name: 'orchestrator_job_input_queue_depth',
//   help: 'Approximate number of messages in the job input SQS queue',
//   async collect() {
//     // Logic to get queue depth from CloudWatch or SQS API
//     // const depth = await getSqsQueueDepth('YourQueueUrl');
//     // this.set(depth);
//   },
//   registers: [register],
// });

console.log('Orchestrator Prometheus metrics definitions loaded.');

// Note: Integrating these into stateless Lambda functions requires a strategy
// for aggregation and exposure. A common pattern is using the Prometheus Pushgateway,
// or scraping metrics from a persistent store like Redis updated by the Lambdas,
// or using the CloudWatch exporter.
// This file primarily defines the metric structures. The exposure mechanism
// will be part of implementing the /metrics endpoint. 