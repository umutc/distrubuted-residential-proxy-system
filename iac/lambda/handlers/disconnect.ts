import { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import logger from '../utils/logger'; // Import the shared logger

// Initialize client outside the handler
const dynamoDb = new DynamoDBClient({});
const AGENT_REGISTRY_TABLE_NAME = process.env.AGENT_REGISTRY_TABLE_NAME;

export const handler = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
  // Log the event at debug level if needed, otherwise just log the connection ID
  // logger.debug({ event }, 'Disconnect Event details');
  const connectionId = event.requestContext.connectionId;
  const log = logger.child({ connectionId }); // Create child logger
  log.info(`Disconnect invoked for connection`);

  if (!AGENT_REGISTRY_TABLE_NAME) {
      log.error({ errorCode: 'ORC-CFG-1001' }, 'AGENT_REGISTRY_TABLE_NAME environment variable not set.');
      // Still return 200 for disconnect, but log the config error
      return { statusCode: 200, body: 'Disconnected (config error).' };
  }

  // Remove agent from registry
  try {
    await dynamoDb.send(new DeleteItemCommand({
      TableName: AGENT_REGISTRY_TABLE_NAME,
      Key: {
        connectionId: { S: connectionId },
      },
    }));
    log.info(`Removed agent connection from registry`);
  } catch (err: any) {
    // Use specific error code for DynamoDB failure
    log.error({ errorCode: 'ORC-DEP-1004', error: err.message, stack: err.stack }, 'Failed to remove agent from registry');
    // Not fatal for disconnect
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Disconnected.' }),
  };
}; 