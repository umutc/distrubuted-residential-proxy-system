import { ApiGatewayManagementApi } from '@aws-sdk/client-apigatewaymanagementapi';
import { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

// Note: Instantiating the client outside the handler for potential reuse
const apiGwManagementApi = new ApiGatewayManagementApi({
  // API Gateway Management API endpoint is constructed dynamically
  // endpoint: `https://${event.requestContext.domainName}/${event.requestContext.stage}`
});

export const handler = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
  console.log('Default Route Event:', JSON.stringify(event, null, 2));

  const connectionId = event.requestContext.connectionId;
  const routeKey = event.requestContext.routeKey;
  const body = event.body ? JSON.parse(event.body) : {}; 
  const action = body.action; // Assuming route selection based on 'action' field

  console.log(`Default route invoked for connection ${connectionId}, routeKey: ${routeKey}, action: ${action}`);

  // Placeholder: Echo back or handle based on 'action'
  // TODO: Implement actual message routing/job handling (Task 4, 6)

  const postData = JSON.stringify({
    message: `Received action: ${action || 'no action specified'}`,
    data: body
  });

  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  const managementApi = new ApiGatewayManagementApi({ endpoint });

  try {
    await managementApi.postToConnection({
      ConnectionId: connectionId,
      Data: postData,
    });
    console.log(`Successfully posted response to ${connectionId}`);
  } catch (err: any) {
    // Handle potential GoneException if the connection is closed
    if (err.statusCode === 410) {
      console.log(`Connection ${connectionId} is gone.`);
      // TODO: Optionally clean up connection if necessary (Task 2)
    } else {
      console.error('Error posting to connection:', err);
      // Return error to potentially trigger API Gateway error handling
      return { statusCode: 500, body: 'Failed to send message.' };
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Default handler executed.' }),
  };
}; 