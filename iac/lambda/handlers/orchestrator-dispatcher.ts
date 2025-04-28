import { SQSEvent, SQSHandler } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand, GoneException } from '@aws-sdk/client-apigatewaymanagementapi'; // Import GoneException
import { marshall } from '@aws-sdk/util-dynamodb';
import { findAvailableAgent, markAgentAsBusy, deleteAgentConnection } from '../utils/agent-registry'; // Import correct utils
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
            const agent = await findAvailableAgent(); 
            if (!agent || !agent.connectionId) {
                // Throw error to let SQS handle retry/DLQ
                console.error(`No available agents found for job ${jobId}. Message ID: ${record.messageId}. Triggering retry/DLQ.`);
                throw new Error(`No available agents found for job ${jobId}`); 
            }
            console.log(`Found available agent ${agent.agentId} (${agent.connectionId}) for job ${jobId}`);

            // 3. Mark agent busy
            console.log(`Marking agent ${agent.agentId} as busy with job ${jobId}`);
            const markedBusy = await markAgentAsBusy(agent.connectionId, jobId);
            if (!markedBusy) {
                // Throw error to let SQS handle retry/DLQ (likely condition check failed)
                console.error(`Failed to mark agent ${agent.agentId} (${agent.connectionId}) as busy for job ${jobId}. Triggering retry/DLQ.`);
                throw new Error(`Failed to mark agent ${agent.agentId} as busy`); 
            }

            // 4. Send job to agent via WebSocket
            const payloadToSend = {
                action: 'execute_job', 
                data: {
                    ...agentJobPayload,
                    jobId: jobId, 
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
                 // If GoneException, agent disconnected between find/mark and send.
                 if (error instanceof GoneException) { // Use instanceof for type check
                    console.warn(`Agent ${agent.connectionId} disconnected before receiving job ${jobId}. Cleaning up registry.`);
                    // Attempt to clean up the registry entry
                    await deleteAgentConnection(agent.connectionId);
                    console.log(`Triggering SQS retry/DLQ for job ${jobId} due to GoneException.`);
                    // Re-throw the error to trigger SQS retry/DLQ
                    throw error; 
                 } else {
                    // Other error sending to agent - don't mark agent available, just trigger retry/DLQ
                    console.error(`Other error sending job ${jobId} to agent ${agent.connectionId}. Triggering SQS retry/DLQ.`);
                    // Re-throw the error to trigger SQS retry/DLQ
                    throw error;
                 }
            }

        } catch (error: any) {
            console.error(`Failed to process SQS message ${record.messageId}:`, error);
            // Throw error to ensure message goes back to queue or DLQ if configured
            throw error; 
        }
    }
}; 