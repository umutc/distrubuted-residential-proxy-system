export interface AgentInfo {
    connectionId: string;
    agentId?: string;
    status: 'connected' | 'registered' | 'busy' | 'available'; // Added available/busy
    capabilities?: string[];
    metadata?: Record<string, any>;
    connectedAt: string;
    updatedAt?: string;
    currentJobId?: string; // Added currentJobId
    ttl?: number;
}

export type JobStatus = 'pending' | 'assigned' | 'in-progress' | 'completed' | 'failed' | 'timeout';

export interface JobData {
    jobId: string; // UUID
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string; // Base64 encoded string
    status: JobStatus;
    createdAt: string;
    updatedAt?: string;
    assignedAgentId?: string;
    assignedConnectionId?: string;
    timeoutMs?: number;
    // Store response data here or link to S3/other storage
    result?: {
        statusCode?: number;
        headers?: Record<string, string>;
        body?: string; // Base64 encoded
        isBase64Encoded?: boolean;
    };
    error?: {
        message: string;
        code?: string;
        details?: any;
    };
}

// --- Agent Specific Types --- //

// Define AgentConfig based on how it might be used (e.g., from env vars)
export interface AgentConfig {
  orchestratorUrl: string;
  agentKey: string;
  gracePeriodMs: number;
  // Add other config properties if needed, e.g.:
  // logLevel?: string;
  // metricsPort?: number;
}

// Define the payload for a job request sent TO the agent
export interface JobRequestPayload {
  jobId: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string; // Could be base64 or utf8 string
  bodyEncoding?: 'base64' | 'utf8';
  timeoutMs?: number;
}

// Define the payload for a successful job response FROM the agent
export interface JobResponsePayload {
  statusCode: number;
  headers: Record<string, string>;
  body: string; // Agent ensures this is base64 encoded if binary
  bodyEncoding: 'base64' | 'utf8';
}

// Define the payload for an error response FROM the agent
export interface ErrorResponsePayload {
  errorCode: string;
  errorMessage: string;
  statusCode?: number; // Optional: Include if an HTTP error occurred
} 