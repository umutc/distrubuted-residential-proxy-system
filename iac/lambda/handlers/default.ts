import { ApiGatewayManagementApi, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

// Note: Instantiating the client outside the handler for potential reuse
const apiGwManagementApi = new ApiGatewayManagementApi({
  // API Gateway Management API endpoint is constructed dynamically
  // endpoint: `https://${event.requestContext.domainName}/${event.requestContext.stage}`
});

// Keep client instantiation outside handler
const managementApi = new ApiGatewayManagementApi({});

export const handler = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
  console.log('Default Route Event:', JSON.stringify(event, null, 2));

  const connectionId = event.requestContext.connectionId;
  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;

  // Ensure client is configured with the correct endpoint for this invocation
  const specificManagementApi = new ApiGatewayManagementApi({ endpoint });

  let responseData = {};
  let statusCode = 200;

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const action = body.action;

    console.log(`Default route invoked for connection ${connectionId}, action: ${action}`);

    // Handle specific actions
    if (action === 'ping') {
      responseData = { action: 'pong', timestamp: Date.now(), receivedData: body.data };
      console.log(`Responding with pong to ${connectionId}`);
    } else {
      // Default action: Echo back or send error
      console.warn(`Unknown action '${action}' received from ${connectionId}`);
      responseData = { error: `Unknown action: ${action || 'none'}`, receivedBody: body };
      // Optionally set a different status code for client errors like 400?
    }

    // Send response back to the client
    await specificManagementApi.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(JSON.stringify(responseData)),
    }));
    console.log(`Successfully posted response to ${connectionId}`);

  } catch (err: any) {
    console.error('Error processing message or posting response:', err);
    // Attempt to send error back if possible, otherwise just log
    responseData = { error: 'Failed to process message', details: err.message };
    statusCode = 500;
    try {
      await specificManagementApi.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(responseData)),
      }));
    } catch (postErr: any) {
      console.error('Failed even to post error back:', postErr);
      // Handle potential GoneException if the connection is closed
      if (postErr.statusCode === 410 || postErr.name === 'GoneException') {
         console.log(`Connection ${connectionId} is gone.`);
         // TODO: Optionally clean up connection if necessary
      }
    }
  }

  // API Gateway requires a 200 response unless there was an integration failure
  return {
    statusCode: 200, // Always return 200 to API GW unless you want to disconnect the client on error
    body: JSON.stringify({ message: statusCode === 200 ? 'Message processed.' : 'Error processing message.' }),
  };
}; 