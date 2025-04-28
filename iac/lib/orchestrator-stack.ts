import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketMockIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export class OrchestratorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB table for WebSocket connections
    const connectionsTable = new dynamodb.Table(this, 'WebSocketConnectionsTable', {
      tableName: 'WebSocketConnections',
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // Suitable for unpredictable workload
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Automatically delete table on stack removal (for development)
    });

    // Define the WebSocket API
    const webSocketApi = new apigwv2.WebSocketApi(this, 'OrchestratorWebSocketApi', {
      apiName: 'OrchestratorWebSocket',
      description: 'WebSocket API for the Distributed Residential Proxy Orchestrator',
      // Route selection expression determines which route handler is invoked
      // We expect messages like { "action": "someAction", ... }
      // So we select based on the 'action' field in the JSON body
      // routeSelectionExpression: '$request.body.action', // Optional: Default is $request.body.action

      // Default routes provided by API Gateway v2
      connectRouteOptions: {
        integration: new WebSocketMockIntegration('ConnectIntegration'), // Placeholder
      },
      disconnectRouteOptions: {
        integration: new WebSocketMockIntegration('DisconnectIntegration'), // Placeholder
      },
      defaultRouteOptions: {
        integration: new WebSocketMockIntegration('DefaultIntegration'), // Placeholder for unhandled actions
      },
    });

    // Output the WebSocket URL
    new cdk.CfnOutput(this, 'WebSocketApiUrl', {
      value: webSocketApi.apiEndpoint,
      description: 'The URL of the WebSocket API',
    });

    // Output the WebSocket API ID for reference
    new cdk.CfnOutput(this, 'WebSocketApiId', {
        value: webSocketApi.apiId,
        description: 'The ID of the WebSocket API',
    });
  }
} 