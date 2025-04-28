import { SQSEvent, SQSHandler } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi'; // Corrected import
import { marshall } from '@aws-sdk/util-dynamodb';
import { findAvailableAgent, markAgentAsBusy, markAgentAsAvailable } from '../utils/agent-registry'; // Import correct utils
import { JobData } from '../utils/types';

const AGENT_REGISTRY_TABLE_NAME = process.env.AGENT_REGISTRY_TABLE_NAME;
const SYNC_JOB_MAPPING_TABLE_NAME = process.env.SYNC_JOB_MAPPING_TABLE_NAME;
const WEBSOCKET_API_ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT?.replace('wss://', '').replace('/dev', ''); // Need DNS name for ApiGatewayManagementApi

if (!AGENT_REGISTRY_TABLE_NAME || !SYNC_JOB_MAPPING_TABLE_NAME || !WEBSOCKET_API_ENDPOINT) {
    throw new Error('Missing required environment variables for Orchestrator Dispatcher.');
}

const dynamoDb = new DynamoDBClient({});
// Note: Endpoint needs to be constructed without wss:// and stage for ApiGatewayManagementApiClient
const apiGwManagementApi = new ApiGatewayManagementApiClient({ endpoint: `https://${WEBSOCKET_API_ENDPOINT}` }); 

const JOB_TTL_BUFFER_SECONDS = 300; // Store sync mapping for 5 mins longer than job timeout

export const handler: SQSHandler = async (event: SQSEvent) => {
    console.log(`Received ${event.Records.length} job messages.`);

    for (const record of event.Records) {
        try {
            console.log(`Processing SQS message ID: ${record.messageId}`);
            const jobData = JSON.parse(record.body) as JobData & { correlationId?: string; responseQueueUrl?: string };
            const { jobId, correlationId, responseQueueUrl, timeoutMs, ...agentJobPayload } = jobData;

            console.log(`Processing job ${jobId}. Sync info present: ${!!correlationId}`);

            // 1. Store sync mapping info if present
            if (correlationId && responseQueueUrl) {
                const ttl = Math.floor(Date.now() / 1000) + Math.ceil((timeoutMs || 30000) / 1000) + JOB_TTL_BUFFER_SECONDS;
                console.log(`Storing sync mapping for job ${jobId} with TTL ${ttl}`);
                await dynamoDb.send(new PutItemCommand({
                    TableName: SYNC_JOB_MAPPING_TABLE_NAME,
                    Item: marshall({
                        jobId: jobId,
                        correlationId: correlationId,
                        responseQueueUrl: responseQueueUrl,
                        ttl: ttl,
                        createdAt: new Date().toISOString(),
                    }),
                }));
                 console.log(`Stored sync mapping for job ${jobId}`);
            }

            // 2. Find available agent
            console.log(`Finding available agent for job ${jobId}...`);
            const agent = await findAvailableAgent(); // Implement this utility
            if (!agent || !agent.connectionId) {
                // TODO: Handle no available agent - requeue message? Send to DLQ?
                console.error(`No available agents found for job ${jobId}. Message ID: ${record.messageId}. Needs requeue/DLQ logic.`);
                // For now, just log and skip
                 continue; 
            }
            console.log(`Found available agent ${agent.agentId} (${agent.connectionId}) for job ${jobId}`);

            // 3. Mark agent busy
            console.log(`Marking agent ${agent.agentId} as busy with job ${jobId}`);
            const markedBusy = await markAgentAsBusy(agent.connectionId, jobId); // Use correct function
            if (!markedBusy) {
                // TODO: Handle failure to mark busy - potential race condition? Retry find agent?
                console.error(`Failed to mark agent ${agent.agentId} (${agent.connectionId}) as busy for job ${jobId}. Skipping dispatch.`);
                 continue; 
            }

            // 4. Send job to agent via WebSocket
            const payloadToSend = {
                action: 'execute_job', // Define the action for the agent
                data: {
                    ...agentJobPayload, // Contains url, method, headers, body, etc.
                    jobId: jobId, // Send jobId so agent can include it in response
                    timeoutMs: timeoutMs || 30000,
                },
            };
            console.log(`Sending job ${jobId} to agent ${agent.agentId} (${agent.connectionId})`);
            try {
                await apiGwManagementApi.send(new PostToConnectionCommand({
                    ConnectionId: agent.connectionId,
                    Data: Buffer.from(JSON.stringify(payloadToSend)),
                }));
                console.log(`Successfully sent job ${jobId} to agent ${agent.agentId}`);
            } catch (error: any) {
                 console.error(`Failed to send job ${jobId} to agent ${agent.connectionId}:`, error);
                 // If GoneException, agent disconnected between find and send.
                 // Need to mark agent as potentially disconnected and retry dispatching the job.
                 if (error.name === 'GoneException') {
                    console.warn(`Agent ${agent.connectionId} disconnected before receiving job ${jobId}. Attempting to handle...`);
                    // TODO: Implement logic to handle GoneException 
                    // - Remove/update agent status in registry
                    // - Requeue the SQS message for retry
                 } else {
                    // Other error sending to agent - might need retry or DLQ
                    // Mark agent available again? Or potentially problematic?
                    await markAgentAsAvailable(agent.connectionId); // Use correct function, revert status on send failure? Risky.
                 }
                 // Re-throw or handle to prevent SQS message deletion? Depends on retry strategy.
                 throw error; // Re-throw for now to let SQS handle retry/DLQ based on queue config
            }

        } catch (error: any) {
            console.error(`Failed to process SQS message ${record.messageId}:`, error);
            // Throw error to ensure message goes back to queue or DLQ if configured
            throw error; 
        }
    }
}; 