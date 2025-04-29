import { ApiGatewayManagementApi, PostToConnectionCommand, GoneException } from '@aws-sdk/client-apigatewaymanagementapi';
import { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { validateMessage } from '../utils/schema-validator';
import { markAgentAsAvailable, updateAgentStatusInRegistry } from '../utils/agent-registry';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
// import { createMetric } from '../utils/metrics'; // Placeholder for future metrics
// import AWS from 'aws-sdk'; // For SQS dead-letter queue if needed
import { DynamoDBClient, UpdateItemCommand, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'; // Import marshall/unmarshall
import { v4 as uuidv4 } from 'uuid';
import { AgentInfo } from '../utils/types';
import logger from '../utils/logger'; // Import the shared logger

// Initialize clients outside the handler for potential reuse
const dynamoDb = new DynamoDBClient({});
const sqsClient = new SQSClient({}); 

const TABLE_NAME = process.env.AGENT_REGISTRY_TABLE_NAME;
const SYNC_JOB_MAPPING_TABLE_NAME = process.env.SYNC_JOB_MAPPING_TABLE_NAME;
// const DEAD_LETTER_QUEUE_URL = process.env.DEAD_LETTER_QUEUE_URL;

// Note: Instantiating the client outside the handler for potential reuse
const apiGwManagementApi = new ApiGatewayManagementApi({
  // API Gateway Management API endpoint is constructed dynamically
  // endpoint: `https://${event.requestContext.domainName}/${event.requestContext.stage}`
});

// Keep client instantiation outside handler
// const managementApi = new ApiGatewayManagementApi({}); // Replaced by api instance below

export const handler = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
  const connectionId = event.requestContext.connectionId;
  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  const handlerRequestId = uuidv4(); // Use a specific ID for this handler invocation
  const startTime = Date.now();
  let statusCode = 200;
  let action = 'unknown'; // Default action for logging
  let originalRequestId = 'unknown'; // Default original request ID

  // Ensure client is configured with the correct endpoint for this invocation
  const api = new ApiGatewayManagementApi({ endpoint });

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    action = body.action || 'unknown';
    originalRequestId = body.requestId || handlerRequestId; // Use handler's if none provided

    // Add connectionId, action, request IDs to all logs within this handler
    const log = logger.child({ connectionId, action, originalRequestId, handlerRequestId });

    // Validate message format
    const validation = validateMessage(body);
    if (!validation.valid) {
      // ORC-VAL-1001 for invalid format
      log.warn({ validationErrors: validation.errors, errorCode: 'ORC-VAL-1001' }, 'Invalid message format received');
      await api.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify({
          error: 'Invalid message format',
          details: validation.errors,
          requestId: originalRequestId
        }))
      }));
      // createMetric('MessageValidationError', 1, [{ Name: 'Action', Value: body.action || 'unknown' }]);
      return { statusCode: 400, body: 'Invalid message format' };
    }

    // Action-based routing
    switch (body.action) {
      case 'ping': {
        await api.send(new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(JSON.stringify({
            action: 'pong',
            requestId: originalRequestId, // Echo original request ID
            timestamp: new Date().toISOString()
          }))
        }));
        log.debug('Processed ping, sent pong.');
        break;
      }
      case 'register': {
        const { agentId, capabilities, metadata } = body.data;
        log.info({ agentId }, 'Processing register action');
        if (!TABLE_NAME) {
            log.error({ errorCode: 'ORC-CFG-1001' }, 'AGENT_REGISTRY_TABLE_NAME environment variable not set.');
            throw new Error('AGENT_REGISTRY_TABLE_NAME not set'); // Throw to trigger catch block
        }
        // Store agent info and set status to available
        try {
          await dynamoDb.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { connectionId: { S: connectionId } },
            UpdateExpression: 'SET agentId = :agentId, capabilities = :capabilities, metadata = :metadata, #status = :status, updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#status': 'status' // Alias for reserved keyword
            },
            ExpressionAttributeValues: {
              ':agentId': { S: agentId },
              ':capabilities': { S: JSON.stringify(capabilities || []) }, // Ensure capabilities is array
              ':metadata': { S: JSON.stringify(metadata || {}) },
              ':status': { S: 'available' }, // Set status to available on registration
              ':updatedAt': { S: new Date().toISOString() }
            }
          }));
        } catch (dbError: any) {
           log.error({ errorCode: 'ORC-DEP-1002', agentId, error: dbError.message, stack: dbError.stack }, 'Failed to update Agent Registry during registration.');
           throw dbError; // Re-throw to trigger main catch block
        }
        try {
          await api.send(new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: Buffer.from(JSON.stringify({
              action: 'register_confirmed',
              requestId: originalRequestId, // Use original request ID
              data: { agentId, message: 'Agent registered successfully' }
            }))
          }));
        } catch (sendError: any) {
           log.error({ errorCode: 'ORC-DEP-1010', agentId, error: sendError.message, stack: sendError.stack }, 'Failed to send registration confirmation to agent.');
           // Decide if this should be fatal or just logged
           // For now, log and continue, registration in DB succeeded.
        }
        log.info({ agentId }, 'Agent registration confirmed.');
        // createMetric('AgentRegistration', 1, [{ Name: 'AgentId', Value: agentId }]);
        break;
      }
      case 'agent_status_update': {
        const statusData = body.data;
        // Basic validation of status data
        if (!statusData || typeof statusData !== 'object' || !statusData.status) {
            log.warn({ receivedData: statusData, errorCode: 'ORC-VAL-1001' }, 'Invalid agent_status_update: Missing or invalid data field.');
            // Optionally send error back, but usually not needed for status updates
            statusCode = 400;
            break; // Exit case
        }
        log.info({ agentStatus: statusData.status, activeJobs: statusData.activeJobCount }, 'Processing agent status update');
        // Update the agent registry, log if update fails but don't block
        await updateAgentStatusInRegistry(connectionId, statusData);
        // No response needed back to the agent for status updates
        break;
      }
      case 'job_response': {
        // Validate job_response data structure
        if (!body.data || typeof body.data !== 'object') {
            log.warn({ receivedData: body.data, errorCode: 'ORC-VAL-1001' }, 'Invalid job_response: Missing or invalid data field.');
            await api.send(new PostToConnectionCommand({
              ConnectionId: connectionId,
              Data: Buffer.from(JSON.stringify({ error: 'Invalid job_response: Missing data field', requestId: originalRequestId }))
            }));
            statusCode = 400;
            break; // Exit case
        }

        const { jobId, status, result, error: jobError } = body.data; // Rename error to avoid conflict
        const jobLog = log.child({ jobId }); // Add jobId to logs for this case

        // Use a finally block to ensure agent is marked available
        try {
            if (!jobId || typeof jobId !== 'string') {
                jobLog.warn({ receivedJobId: jobId, errorCode: 'ORC-VAL-1001' }, 'Invalid job_response: Missing or invalid jobId.');
                await api.send(new PostToConnectionCommand({
                  ConnectionId: connectionId,
                  Data: Buffer.from(JSON.stringify({ error: 'Invalid job_response: Missing or invalid jobId', requestId: originalRequestId }))
                }));
                statusCode = 400;
            } else if (!status || !['success', 'failure'].includes(status)) {
                jobLog.warn({ statusReceived: status, errorCode: 'ORC-VAL-1001' }, `Invalid job_response: Missing or invalid status.`);
                await api.send(new PostToConnectionCommand({
                  ConnectionId: connectionId,
                  Data: Buffer.from(JSON.stringify({ error: `Invalid job_response: Missing or invalid status: ${status}`, jobId: jobId, requestId: originalRequestId }))
                }));
                statusCode = 400;
            } else {
                // Log job response
                jobLog.info({ status }, `Received job response`);
                if (status === 'success' && result) {
                  jobLog.info({ targetStatusCode: result.statusCode, isBase64: result.isBase64Encoded }, `Job success result details`);
                  // TODO (Future Task): Store successful result in JobRepository/DynamoDB
                } else if (status === 'failure' && jobError) {
                  jobLog.error({ jobErrorMessage: jobError.message, jobErrorCode: jobError.code, targetStatusCode: jobError.statusCode }, `Job failure details`);
                  // TODO (Future Task): Store error details in JobRepository/DynamoDB
                }

                // --- Notify Waiting Synchronous Handler (if applicable) --- 
                if (SYNC_JOB_MAPPING_TABLE_NAME) {
                  try {
                    jobLog.info({ syncMapTable: SYNC_JOB_MAPPING_TABLE_NAME }, `Checking sync mapping table for sync info.`);
                    const getItemCommand = new GetItemCommand({
                      TableName: SYNC_JOB_MAPPING_TABLE_NAME,
                      Key: marshall({ jobId: jobId }),
                    });
                    const syncInfoResult = await dynamoDb.send(getItemCommand);

                    if (syncInfoResult.Item) {
                      const syncInfo = unmarshall(syncInfoResult.Item);
                      const { responseQueueUrl, correlationId } = syncInfo;
                      const syncLog = jobLog.child({ correlationId, responseQueueUrl });

                      if (responseQueueUrl && correlationId) {
                        syncLog.info(`Found sync info. Sending response to queue.`);
                        
                        // Construct response payload for the original API caller
                        const responsePayload = {
                          jobId: jobId,
                          status: status,
                          // Extract relevant details from result or jobError for the API response
                          // Ensure sensitive details are not leaked if necessary
                          payload: status === 'success' ? result : { error: jobError },
                        };

                        // Send response to the temporary queue
                        await sqsClient.send(new SendMessageCommand({
                          QueueUrl: responseQueueUrl,
                          MessageBody: JSON.stringify(responsePayload),
                          MessageGroupId: correlationId, // Use correlationId for FIFO queue
                        }));
                        syncLog.info(`Successfully sent response to queue`);

                        // Delete the mapping entry from DynamoDB
                        await dynamoDb.send(new DeleteItemCommand({
                          TableName: SYNC_JOB_MAPPING_TABLE_NAME,
                          Key: marshall({ jobId: jobId }),
                        }));
                        syncLog.info({ syncMapTable: SYNC_JOB_MAPPING_TABLE_NAME }, `Deleted sync mapping info from table`);

                      } else {
                         syncLog.warn({ syncInfoReceived: syncInfo, errorCode: 'ORC-JOB-1000' /* General job processing issue */ }, `Sync info found but missing responseQueueUrl or correlationId.`);
                      }
                    } else {
                       jobLog.info(`No sync info found. Assuming async job or timed out.`);
                    }
                  } catch (syncNotifyError: any) {
                     // Map specific AWS SDK errors if possible, otherwise use generic codes
                     let errorCode = 'ORC-DEP-1000'; // Generic dependency error
                     if (syncNotifyError.name === 'ResourceNotFoundException') {
                          errorCode = 'ORC-DEP-1009'; // Specific for DynamoDB get/delete item fail
                     } else if (syncNotifyError.name === 'QueueDoesNotExist') {
                          errorCode = 'ORC-DEP-1005'; // Specific for SQS send fail
                     } 
                     jobLog.error({ errorCode, error: syncNotifyError.message, stack: syncNotifyError.stack }, `Error during sync notification process`);
                     // Log error, but don't fail the primary job response handling for the agent
                  }
                } else {
                   jobLog.warn({ jobId }, `SYNC_JOB_MAPPING_TABLE_NAME not set. Skipping sync notification check.`);
                }

                // --- Acknowledge receipt to Agent --- 
                try {
                  await api.send(new PostToConnectionCommand({
                    ConnectionId: connectionId,
                    Data: Buffer.from(JSON.stringify({ action: 'job_response_received', requestId: originalRequestId, data: { jobId } }))
                  }));
                  jobLog.debug('Sent job_response_received acknowledgement to agent.');
                } catch (ackError: any) {
                   // Log if acknowledgement fails, but don't block marking agent available
                   jobLog.warn({ errorCode: 'ORC-DEP-1010', error: ackError.message }, 'Failed to send job_response_received ack to agent.');
                }
            }
        } finally {
            // --- Mark agent as available (Crucial step in finally block) ---
            jobLog.info('Attempting to mark agent as available after processing job response.');
            await markAgentAsAvailable(connectionId);
            // Note: markAgentAsAvailable should contain its own error logging.
        }
        break;
      }
      default: {
        log.warn({ errorCode: 'ORC-VAL-1001' /* Unknown Action */ }, `No handler for action.`);
        await api.send(new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(JSON.stringify({
            error: 'Unknown action',
            requestId: originalRequestId
          }))
        }));
      }
    }
    // Record processing time metric (placeholder)
    // const processingTime = Date.now() - startTime;
    // createMetric('MessageProcessingTime', processingTime, [{ Name: 'Action', Value: body.action }]);
    return { statusCode, body: 'Message processed' }; // Return potentially updated status code
  } catch (error: any) {
    // Log with context established at the start of the handler
    // Use a generic Orchestrator internal error code here
    logger.child({ connectionId, action, originalRequestId, handlerRequestId }).error({ errorCode: 'ORC-UNK-1000', error: error.message, stack: error.stack }, `Error processing message`);
    statusCode = 500;
    // Optionally send to dead letter queue here
    // if (DEAD_LETTER_QUEUE_URL) { ... }
    try {
      await api.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify({
          error: 'Failed to process message',
          details: error.message,
          requestId: originalRequestId // Use original or handlerRequestId
        }))
      }));
      logger.warn({ connectionId, action, originalRequestId, handlerRequestId }, 'Sent error notification to client due to processing failure.');
    } catch (sendError: any) {
       // Use specific code for failure to post back to connection
       let errorCode = 'ORC-DEP-1010'; 
       if (sendError instanceof GoneException) {
          errorCode = 'ORC-DEP-1011';
       }
       logger.error({ errorCode, connectionId, action, originalRequestId, handlerRequestId, sendErrorName: sendError.name, sendErrorMessage: sendError.message }, 'Failed to send error message back to client.');
    }
    return { statusCode: 500, body: 'Internal server error' };
  }
}; 