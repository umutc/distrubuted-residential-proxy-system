import { SQSEvent, SQSHandler, SQSRecord } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand, GoneException } from '@aws-sdk/client-apigatewaymanagementapi'; // Import GoneException
import { marshall } from '@aws-sdk/util-dynamodb';
import { findAvailableAgent, markAgentAsBusy, deleteAgentConnection } from '../utils/agent-registry'; // Import correct utils
import { JobData } from '../utils/types';
import logger from '../utils/logger'; // Import the shared logger
import {
    jobsDistributedCounter,
    jobDistributionErrorsCounter,
    availableAgentsGauge,
    busyAgentsGauge
} from '../utils/metrics';

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
const MAX_RETRY_ATTEMPTS = 3; // Max number of retries for transient errors

export const handler: SQSHandler = async (event: SQSEvent) => {
    // Log overall event reception
    logger.info({ messageCount: event.Records.length }, `Orchestrator dispatcher received SQS messages.`);

    // Process records individually, allowing partial failures if needed (though currently re-throwing)
    const promises = event.Records.map(async (record: SQSRecord) => { 
        const messageId = record.messageId;
        // Get retry count from SQS message attributes
        const approximateReceiveCount = parseInt(record.attributes.ApproximateReceiveCount || '1', 10);
        const log = logger.child({ sqsMessageId: messageId, approximateReceiveCount }); // Base logger for this message
        let jobId = 'unknown'; // Default jobId for logging if parsing fails
        let correlationId: string | undefined;
        let responseQueueUrl: string | undefined;
        let markedBusy = false; // Track if we successfully marked agent busy
        try {
            log.info(`Processing SQS message (Attempt ${approximateReceiveCount})`);
            let jobData: JobData & { correlationId?: string; responseQueueUrl?: string };
            try {
              jobData = JSON.parse(record.body);
            } catch (parseError: any) {
               log.error({ errorCode: 'ORC-VAL-1000', error: parseError.message, rawBody: record.body }, 'Failed to parse SQS message body');
               // Cannot proceed, throw error to potentially DLQ the message
               throw new Error('Failed to parse SQS message body');
            }
            
            // Update jobId for more specific logging
            jobId = jobData.jobId || 'unknown';
            const jobLog = log.child({ jobId }); // Specific logger with jobId

            correlationId = jobData.correlationId;
            responseQueueUrl = jobData.responseQueueUrl;

            jobLog.info({ isSync: !!correlationId }, `Processing job`);

            // 1. Store sync mapping info if present
            if (correlationId && responseQueueUrl) {
                const ttl = Math.floor(Date.now() / 1000) + Math.ceil((jobData.timeoutMs || 30000) / 1000) + JOB_TTL_BUFFER_SECONDS;
                jobLog.info({ ttl, correlationId, responseQueueUrl, syncMapTable: SYNC_JOB_MAPPING_TABLE_NAME }, `Storing sync mapping info`);
                try {
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
                  jobLog.info(`Stored sync mapping.`);
                } catch (dbError: any) {
                   jobLog.error({ errorCode: 'ORC-DEP-1009', error: dbError.message, stack: dbError.stack }, 'Failed to store sync job mapping info.');
                   // Decide if this is fatal. If we can't store mapping, sync flow will fail.
                   // Throwing error seems appropriate to retry/DLQ.
                   throw dbError;
                }
            }

            // 2. Find available agent
            jobLog.info(`Finding available agent...`);
            const agent = await findAvailableAgent();
            if (!agent || !agent.connectionId) {
                // Throw error to let SQS handle retry/DLQ
                const errorCode = 'ORC-JOB-1001';
                jobLog.error({ errorCode }, `No available agents found.`);
                jobDistributionErrorsCounter.labels({ reason: 'no_agent_available' }).inc();
                if (approximateReceiveCount >= MAX_RETRY_ATTEMPTS) {
                     jobLog.warn({ errorCode }, `Max retry attempts (${MAX_RETRY_ATTEMPTS}) reached for finding agent. Sending to DLQ.`);
                     throw new Error(`[Retryable Error] No available agents found for job ${jobId} after ${approximateReceiveCount} attempts.`); 
                } else {
                     jobLog.info({ errorCode }, `Attempting retry #${approximateReceiveCount} for finding agent.`);
                     // Don't throw immediately, let SQS redeliver after visibility timeout
                     // Returning successfully allows SQS to handle the retry based on visibility timeout.
                     // We might want to adjust visibility timeout here in the future for backoff
                     return; // Stop processing this record, let SQS handle retry
                }
            }
            jobLog.info({ agentId: agent.agentId, connectionId: agent.connectionId }, `Found available agent`);

            // 3. Mark agent busy
            jobLog.info({ agentId: agent.agentId, connectionId: agent.connectionId }, `Marking agent as busy`);
            markedBusy = await markAgentAsBusy(agent.connectionId, jobId);
            if (!markedBusy) {
                // Throw error to let SQS handle retry/DLQ (likely condition check failed)
                const errorCode = 'ORC-JOB-1002';
                jobLog.error({ errorCode, agentId: agent.agentId, connectionId: agent.connectionId }, `Failed to mark agent as busy (maybe became unavailable?).`);
                 if (approximateReceiveCount >= MAX_RETRY_ATTEMPTS) {
                     jobLog.warn({ errorCode }, `Max retry attempts (${MAX_RETRY_ATTEMPTS}) reached for marking agent busy. Sending to DLQ.`);
                     throw new Error(`[Retryable Error] Failed to mark agent ${agent.agentId} as busy after ${approximateReceiveCount} attempts`); 
                } else {
                     jobLog.info({ errorCode }, `Attempting retry #${approximateReceiveCount} for marking agent busy.`);
                     // Returning successfully allows SQS to handle the retry based on visibility timeout.
                     return; // Stop processing this record, let SQS handle retry
                }
            }
            jobLog.info({ agentId: agent.agentId, connectionId: agent.connectionId }, `Agent marked as busy and metrics updated`);
            availableAgentsGauge.dec();
            busyAgentsGauge.inc();

            // 4. Send job to agent via WebSocket
            const payloadToSend = {
                action: 'execute_job', 
                data: {
                    ...jobData,
                    jobId: jobId, 
                    timeoutMs: jobData.timeoutMs || 30000,
                },
            };
            jobLog.info({ agentId: agent.agentId, connectionId: agent.connectionId }, `Sending job to agent`);
            try {
                await apiGwManagementApi.send(new PostToConnectionCommand({
                    ConnectionId: agent.connectionId,
                    Data: Buffer.from(JSON.stringify(payloadToSend)),
                }));
                jobsDistributedCounter.inc();
                jobLog.info({ agentId: agent.agentId }, `Successfully sent job to agent`);
            } catch (error: any) {
                 let errorCode = 'ORC-DEP-1010'; // Default WebSocket send error
                 // If GoneException, agent disconnected between find/mark and send.
                 if (error instanceof GoneException) { // Use instanceof for type check
                    errorCode = 'ORC-DEP-1011';
                    jobLog.warn({ errorCode, connectionId: agent.connectionId }, `Agent disconnected before receiving job (GoneException). Cleaning up registry.`);
                    // Attempt to clean up the registry entry
                    await deleteAgentConnection(agent.connectionId);
                    jobLog.info(`Triggering SQS retry/DLQ due to GoneException.`);
                    // Re-throw the error to trigger SQS retry/DLQ
                    // Check retry count for GoneException as well
                     if (approximateReceiveCount >= MAX_RETRY_ATTEMPTS) {
                         jobLog.warn({ errorCode }, `Max retry attempts (${MAX_RETRY_ATTEMPTS}) reached for GoneException. Sending to DLQ.`);
                         throw new Error(`[Retryable Error] Agent ${agent.connectionId} disconnected after ${approximateReceiveCount} attempts (GoneException).`);
                     } else {
                         jobLog.info({ errorCode }, `Attempting retry #${approximateReceiveCount} due to GoneException.`);
                         // Don't re-throw immediately, let SQS retry. The agent registry cleanup already happened.
                         // Returning successfully allows SQS to handle the retry based on visibility timeout.
                         return; // Stop processing this record, let SQS handle retry
                     }
                 } else {
                    // Other error sending to agent - THIS IS LIKELY NOT RETRYABLE
                    // If we can't send for another reason, retrying might not help.
                    jobLog.error({ errorCode, connectionId: agent.connectionId, error: error.message, stack: error.stack }, `Non-retryable error sending job to agent. Sending to DLQ.`);
                    // Re-throw the error to trigger SQS retry/DLQ
                    throw error;
                 }
            }

        } catch (error: any) {
            const errorCode = 'ORC-DSP-1000'; // General dispatcher error
            // Use the main log instance, adding jobId if available
            const errorLog = jobId ? log.child({ jobId }) : log;
            errorLog.error({ errorCode, error: error.message, stack: error.stack, body: record.body }, 'Unhandled error processing SQS record');
            jobDistributionErrorsCounter.labels({ reason: 'unhandled_exception' }).inc();

            // Check if an agent was potentially marked busy before this error occurred
            // Relies on connectionId and agentId being defined earlier if agent selection succeeded
            if (markedBusy && agent && agent.connectionId) { 
                 log.warn({ agentId: agent.agentId, connectionId: agent.connectionId }, 'Attempting to revert agent status due to unhandled exception.');
                 try {
                    // Ensure markAgentAvailable exists and handles potential errors
                    await markAgentAsBusy(agent.connectionId, null);
                    availableAgentsGauge.inc(); // Revert metric
                    busyAgentsGauge.dec();    // Revert metric
                    log.info({ agentId: agent.agentId, connectionId: agent.connectionId }, 'Agent status reverted to available after exception.');
                 } catch (revertError: any) {
                    // Log critical failure to revert status
                    log.fatal({ errorCode: 'ORC-DSP-1003', agentId: agent.agentId, connectionId: agent.connectionId, error: revertError.message, stack: revertError.stack }, 'CRITICAL: Failed to revert agent status after unhandled exception!');
                    // Consider additional alerting here
                 }
            } else {
                 // Log if no revert was needed or possible
                 log.debug({ markedBusy, connectionIdExists: !!agent?.connectionId }, 'No agent status to revert or agent was not marked busy.');
            }
            
            // Let SQS handle retries/DLQ based on Lambda configuration
            throw error; // Re-throw the original error to signal failure to SQS
        }
    });

    // Wait for all record processing promises to settle
    // Note: If any promise rejects (throws an error), the whole Lambda invocation might fail
    // depending on SQS trigger configuration (ReportBatchItemFailures). 
    // For simplicity now, we let the whole batch fail if one message hits max retries or has a non-retryable error.
    await Promise.allSettled(promises);

    // If using ReportBatchItemFailures, you would collect failed message IDs and return them.
    // For now, this handler assumes default behavior (entire batch fails on error).
}; 