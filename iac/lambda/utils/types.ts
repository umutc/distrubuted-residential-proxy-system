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