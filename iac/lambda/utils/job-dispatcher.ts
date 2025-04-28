import { ApiGatewayManagementApi, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { findAvailableAgent, markAgentAsBusy, markAgentAsAvailable } from './agent-registry';
import { JobData } from './types';

/**
 * Dispatches a job to an available agent.
 */
export async function dispatchJob(job: JobData, webSocketEndpoint: string): Promise<boolean> {
    console.log(`Attempting to dispatch job: ${job.jobId}`);

    const availableAgent = await findAvailableAgent();

    if (!availableAgent) {
        console.log(`[${job.jobId}] No available agents to dispatch job.`);
        // TODO: Implement retry logic or queueing mechanism
        return false;
    }

    const agentConnectionId = availableAgent.connectionId;

    // Attempt to mark the agent as busy
    const markedBusy = await markAgentAsBusy(agentConnectionId, job.jobId);

    if (!markedBusy) {
        console.log(`[${job.jobId}] Failed to mark agent ${agentConnectionId} as busy, retrying dispatch...`);
        // Optionally retry finding another agent immediately or after a short delay
        // For simplicity, we just return false for now
        return false;
    }

    // Construct the job request message
    const jobRequestMessage = {
        action: 'job_request',
        requestId: `job-${job.jobId}`, // Link request to job ID
        data: {
            jobId: job.jobId,
            url: job.url,
            method: job.method,
            headers: job.headers,
            body: job.body, // Assumes body is already correctly formatted (e.g., Base64)
            timeoutMs: job.timeoutMs
        }
    };

    // Send the job to the agent via WebSocket
    try {
        // Use the endpoint passed as an argument
        if (!webSocketEndpoint) {
            throw new Error('WebSocket API endpoint was not provided to dispatchJob.');
        }
        const managementApi = new ApiGatewayManagementApi({ endpoint: webSocketEndpoint.replace('wss://', 'https://') }); // SDK needs HTTPS endpoint

        await managementApi.send(new PostToConnectionCommand({
            ConnectionId: agentConnectionId,
            Data: Buffer.from(JSON.stringify(jobRequestMessage))
        }));

        console.log(`[${job.jobId}] Successfully sent job to agent ${availableAgent.agentId || agentConnectionId}`);

        // TODO: Implement timeout mechanism here (e.g., start Step Function Wait, schedule SQS message)
        // For now, assume success after sending
        // Update job status to 'assigned' or 'in-progress' in the JobRepository

        return true;

    } catch (error: any) {
        console.error(`[${job.jobId}] Failed to send job to agent ${agentConnectionId}:`, error);
        // Rollback: Mark agent as available again if sending failed
        await markAgentAsAvailable(agentConnectionId);
        // TODO: Update job status to 'failed' in JobRepository
        return false;
    }
}

// Placeholder for JobRepository interaction (implement later)
// async function updateJobStatus(jobId: string, status: JobStatus, details?: any) { ... } 