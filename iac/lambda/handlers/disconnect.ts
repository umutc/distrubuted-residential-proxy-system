import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import logger from '../utils/logger'; // Import the shared logger
import { connectedAgentsGauge, availableAgentsGauge, busyAgentsGauge } from '../utils/metrics'; // Import metrics

// Initialize client outside the handler
const dynamoDBClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoDBClient); // Create DocumentClient
const AGENT_REGISTRY_TABLE_NAME = process.env.AGENT_REGISTRY_TABLE_NAME;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Log the event at debug level if needed, otherwise just log the connection ID
  // logger.debug({ event }, 'Disconnect Event details');
  const connectionId = event.requestContext.connectionId;
  const log = logger.child({ connectionId }); // Create child logger
  log.info('Processing $disconnect');

  if (!AGENT_REGISTRY_TABLE_NAME) {
      log.error({ errorCode: 'ORC-CFG-1002' }, 'AGENT_REGISTRY_TABLE_NAME environment variable not set.');
      return { statusCode: 500, body: 'Internal server configuration error.' };
  }

  try {
    // Get the agent's status before deleting using DocumentClient
    const getCommand = new GetCommand({
      TableName: AGENT_REGISTRY_TABLE_NAME,
      Key: { connectionId }
    });
    const agentData = await docClient.send(getCommand);
    const agentStatus = agentData.Item?.status;

    // Delete the connection using DocumentClient for consistency (optional, but simpler)
    const deleteCommand = new DeleteCommand({
      TableName: AGENT_REGISTRY_TABLE_NAME,
      Key: { connectionId }
    });
    await docClient.send(deleteCommand);
    log.info(`Removed agent connection from registry`);

    // Decrement gauges based on previous status
    connectedAgentsGauge.dec();
    if (agentStatus === 'available') {
      availableAgentsGauge.dec();
    } else if (agentStatus === 'busy') {
      busyAgentsGauge.dec();
    }
    // Only log if status was found
    if (agentStatus) {
      log.info({ previousStatus: agentStatus }, 'Agent metrics updated after disconnect.');
    } else {
      log.warn('Could not determine agent status before disconnect. Only decrementing total connected count.');
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Disconnected.' }),
    };
  } catch (err: any) {
    // Use specific error code for DynamoDB failure
    log.error({ errorCode: 'ORC-DEP-1004', error: err.message, stack: err.stack }, 'Failed to process disconnection');
    // Do not decrement gauges if an error occurs during processing
    return { statusCode: 500, body: 'Failed to handle disconnection.' };
  }
}; 