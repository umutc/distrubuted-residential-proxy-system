import { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient, DeleteItemCommand } from '@aws-sdk/client-dynamodb';

export const handler = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
  console.log('Disconnect Event:', JSON.stringify(event, null, 2));

  const connectionId = event.requestContext.connectionId;
  console.log(`Disconnect invoked for connection: ${connectionId}`);

  const dynamo = new DynamoDBClient({});
  const AGENT_REGISTRY_TABLE_NAME = process.env.AGENT_REGISTRY_TABLE_NAME || 'distributed-res-proxy-agent-registry';

  // Remove agent from registry
  try {
    await dynamo.send(new DeleteItemCommand({
      TableName: AGENT_REGISTRY_TABLE_NAME,
      Key: {
        connectionId: { S: connectionId },
      },
    }));
    console.log(`Removed agent connection: ${connectionId}`);
  } catch (err) {
    console.error('Failed to remove agent:', err);
    // Not fatal for disconnect
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Disconnected.' }),
  };
}; 