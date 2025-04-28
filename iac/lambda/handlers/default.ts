import { ApiGatewayManagementApi, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { validateMessage } from '../utils/schema-validator';
import { markAgentAsAvailable } from '../utils/agent-registry';
// import { createMetric } from '../utils/metrics'; // Placeholder for future metrics
// import AWS from 'aws-sdk'; // For SQS dead-letter queue if needed
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { AgentInfo } from '../utils/types';

const dynamoDb = new DynamoDBClient({});
const TABLE_NAME = process.env.AGENT_REGISTRY_TABLE_NAME;
// const DEAD_LETTER_QUEUE_URL = process.env.DEAD_LETTER_QUEUE_URL;

// Note: Instantiating the client outside the handler for potential reuse
const apiGwManagementApi = new ApiGatewayManagementApi({
  // API Gateway Management API endpoint is constructed dynamically
  // endpoint: `https://${event.requestContext.domainName}/${event.requestContext.stage}`
});

// Keep client instantiation outside handler
const managementApi = new ApiGatewayManagementApi({});

export const handler = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
  const connectionId = event.requestContext.connectionId;
  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  const requestId = uuidv4();
  const startTime = Date.now();
  let statusCode = 200;

  // Ensure client is configured with the correct endpoint for this invocation
  const api = new ApiGatewayManagementApi({ endpoint });

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    // Validate message format
    const validation = validateMessage(body);
    if (!validation.valid) {
      console.warn(`Invalid message format: ${JSON.stringify(validation.errors)}`);
      await api.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify({
          error: 'Invalid message format',
          details: validation.errors,
          requestId: body.requestId || requestId
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
            requestId: body.requestId || requestId,
            timestamp: new Date().toISOString()
          }))
        }));
        break;
      }
      case 'register': {
        const { agentId, capabilities, metadata } = body.data;
        if (!TABLE_NAME) throw new Error('AGENT_REGISTRY_TABLE_NAME not set');
        // Store agent info and set status to available
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
        await api.send(new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(JSON.stringify({
            action: 'register_confirmed',
            requestId: body.requestId || requestId,
            data: { agentId, message: 'Agent registered successfully' }
          }))
        }));
        // createMetric('AgentRegistration', 1, [{ Name: 'AgentId', Value: agentId }]);
        break;
      }
      case 'job_response': {
        // Validate job_response data structure
        if (!body.data || typeof body.data !== 'object') {
            console.warn(`Invalid job_response: Missing or invalid data field.`);
            await api.send(new PostToConnectionCommand({
              ConnectionId: connectionId,
              Data: Buffer.from(JSON.stringify({ error: 'Invalid job_response: Missing data field', requestId: body.requestId || requestId }))
            }));
            statusCode = 400;
            break; // Exit case
        }

        const { jobId, status, result, error: jobError } = body.data; // Rename error to avoid conflict

        if (!jobId || typeof jobId !== 'string') {
            console.warn(`Invalid job_response: Missing or invalid jobId.`);
            await api.send(new PostToConnectionCommand({
              ConnectionId: connectionId,
              Data: Buffer.from(JSON.stringify({ error: 'Invalid job_response: Missing or invalid jobId', requestId: body.requestId || requestId }))
            }));
            statusCode = 400;
            break; // Exit case
        }

        if (!status || !['success', 'failure'].includes(status)) {
            console.warn(`Invalid job_response for ${jobId}: Missing or invalid status (${status}).`);
            await api.send(new PostToConnectionCommand({
              ConnectionId: connectionId,
              Data: Buffer.from(JSON.stringify({ error: `Invalid job_response: Missing or invalid status: ${status}`, jobId: jobId, requestId: body.requestId || requestId }))
            }));
            statusCode = 400;
            break; // Exit case
        }

        // Log job response (actual job processing logic would go here)
         console.log(`Received job response for job ${jobId} with status ${status}`);
        if (status === 'success' && result) {
          console.log(`[${jobId}] Result: StatusCode=${result.statusCode}, Base64Encoded=${result.isBase64Encoded}`);
          // TODO (Future Task): Store successful result in JobRepository/DynamoDB
        } else if (status === 'failure' && jobError) {
          console.error(`[${jobId}] Error: ${jobError.message}, StatusCode=${jobError.statusCode}`);
          // TODO (Future Task): Store error details in JobRepository/DynamoDB
        }

        // --- Mark Agent as Available --- 
        const markedAvailable = await markAgentAsAvailable(connectionId);
        if (!markedAvailable) {
          // Log the error, but proceed with acknowledgement - don't block response path
          console.error(`[${jobId}] Failed to mark agent ${connectionId} as available after job completion.`);
          // Consider adding a metric here
        }

        // --- Send Acknowledgement --- 
        await api.send(new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(JSON.stringify({
            action: 'job_response_received',
            requestId: body.requestId || requestId,
            data: { jobId }
          }))
        }));
        // createMetric('JobResponse', 1, [ { Name: 'Status', Value: status }, { Name: 'JobId', Value: jobId } ]);
        break;
      }
      default: {
        console.warn(`No handler for action: ${body.action}`);
        await api.send(new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(JSON.stringify({
            error: 'Unknown action',
            requestId: body.requestId || requestId
          }))
        }));
      }
    }
    // Record processing time metric (placeholder)
    // const processingTime = Date.now() - startTime;
    // createMetric('MessageProcessingTime', processingTime, [{ Name: 'Action', Value: body.action }]);
    return { statusCode: 200, body: 'Message processed' };
  } catch (error: any) {
    console.error(`Error processing message: ${error}`);
    statusCode = 500;
    // Optionally send to dead letter queue here
    // if (DEAD_LETTER_QUEUE_URL) { ... }
    try {
      await api.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify({
          error: 'Failed to process message',
          details: error.message,
          requestId
        }))
      }));
    } catch (postErr: any) {
      console.error('Failed even to post error back:', postErr);
      if (postErr.statusCode === 410 || postErr.name === 'GoneException') {
        console.log(`Connection ${connectionId} is gone.`);
      }
    }
    return { statusCode: 500, body: 'Internal server error' };
  }
}; 