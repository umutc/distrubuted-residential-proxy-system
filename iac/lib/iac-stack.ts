import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from '@aws-cdk/aws-apigatewayv2-alpha';
import { CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaIntegration } from '@aws-cdk/aws-apigatewayv2-integrations-alpha';
import { WebSocketStage } from '@aws-cdk/aws-apigatewayv2-alpha';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
// Use WebSocketIntegration directly for placeholder ARN
import { WebSocketIntegration, WebSocketIntegrationType } from '@aws-cdk/aws-apigatewayv2-alpha';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigw1 from 'aws-cdk-lib/aws-apigateway';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

// Placeholder Lambda ARN (replace in later tasks)
const PLACEHOLDER_LAMBDA_URI = 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:placeholderFunction/invocations';

export class OrchestratorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- IAM Role for WebSocket Handlers ---
    const webSocketHandlerRole = new iam.Role(this, 'WebSocketHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        // Basic execution policy
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Add policy to manage WebSocket connections
    webSocketHandlerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['execute-api:ManageConnections'],
      resources: [`arn:aws:execute-api:${this.region}:${this.account}:*/*`], // Adjust scope as needed
    }));

    // TODO: Add DynamoDB permissions later (Task 2)

    // --- Agent API Keys Secret ---
    const agentApiKeysSecret = new secretsmanager.Secret(this, 'AgentApiKeysSecret', {
      secretName: 'distributed-res-proxy-agent-keys',
      description: 'API keys for authenticating residential proxy agents',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'dummy',
      },
    });

    // --- Agent Registry DynamoDB Table ---
    const agentRegistryTable = new dynamodb.Table(this, 'AgentRegistryTable', {
      tableName: 'distributed-res-proxy-agent-registry',
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Lambda Functions ---

    const connectHandler = new lambda_nodejs.NodejsFunction(this, 'ConnectHandler', {
      entry: path.join(__dirname, '../lambda/handlers/connect.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_LATEST,
      role: webSocketHandlerRole,
      environment: {
        AGENT_KEYS_SECRET_NAME: agentApiKeysSecret.secretName,
        AGENT_REGISTRY_TABLE_NAME: agentRegistryTable.tableName,
      },
    });
    new logs.LogGroup(this, 'ConnectHandlerLogGroup', {
      logGroupName: `/aws/lambda/${connectHandler.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const disconnectHandler = new lambda_nodejs.NodejsFunction(this, 'DisconnectHandler', {
      entry: path.join(__dirname, '../lambda/handlers/disconnect.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_LATEST,
      role: webSocketHandlerRole,
    });
    new logs.LogGroup(this, 'DisconnectHandlerLogGroup', {
      logGroupName: `/aws/lambda/${disconnectHandler.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const defaultHandler = new lambda_nodejs.NodejsFunction(this, 'DefaultHandler', {
      entry: path.join(__dirname, '../lambda/handlers/default.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_LATEST,
      role: webSocketHandlerRole,
    });
    new logs.LogGroup(this, 'DefaultHandlerLogGroup', {
      logGroupName: `/aws/lambda/${defaultHandler.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Grant Permissions ---
    agentApiKeysSecret.grantRead(connectHandler); // Grant connect Lambda permission to read the secret
    agentRegistryTable.grantReadWriteData(connectHandler);
    agentRegistryTable.grantReadWriteData(disconnectHandler);
    agentRegistryTable.grantReadWriteData(defaultHandler);

    // --- WebSocket API Gateway ---

    const webSocketApi = new apigwv2.WebSocketApi(this, 'ResidentialProxyWebSocketApi', {
      apiName: 'ResidentialProxyWebSocketApi',
      description: 'WebSocket API for Distributed Residential Proxy System',
      routeSelectionExpression: '$request.body.action',
      // Define connect/disconnect routes directly for cleaner integration setup
      connectRouteOptions: { integration: new WebSocketLambdaIntegration('ConnectIntegration', connectHandler) },
      disconnectRouteOptions: { integration: new WebSocketLambdaIntegration('DisconnectIntegration', disconnectHandler) },
    });

    // Add default route separately
    webSocketApi.addRoute('$default', {
      integration: new WebSocketLambdaIntegration('DefaultIntegration', defaultHandler),
    });

    // --- Deployment Stage ---

    // Create a log group for API Gateway access logs
    const wsApiAccessLogGroup = new logs.LogGroup(this, 'WebSocketApiAccessLogGroup', {
      logGroupName: '/aws/apigateway/ResidentialProxyWebSocketApi-access',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- IAM Role for API Gateway Logging ---
    const apiGwLogsRole = new iam.Role(this, 'ApiGatewayLogsRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs'),
      ],
    });

    // --- Account-level API Gateway CloudWatch Logs Role Setting ---
    new apigw1.CfnAccount(this, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apiGwLogsRole.roleArn,
    }).node.addDependency(apiGwLogsRole);

    // Grant API Gateway permission to write to the log group
    wsApiAccessLogGroup.grantWrite(new iam.ServicePrincipal('apigateway.amazonaws.com'));

    // --- Outputs ---

    // WebSocket API endpoint format: wss://{apiId}.execute-api.{region}.amazonaws.com/{stageName}
    new cdk.CfnOutput(this, 'WebSocketApiEndpoint', {
      value: `wss://${webSocketApi.apiId}.execute-api.${this.region}.amazonaws.com/dev`,
      description: 'The URL of the WebSocket API endpoint',
    });

    new cdk.CfnOutput(this, 'WebSocketApiId', {
        value: webSocketApi.apiId,
        description: 'The ID of the WebSocket API',
    });

    // Output the API Gateway CloudWatch Logs Role ARN
    new cdk.CfnOutput(this, 'ApiGatewayLogsRoleArn', {
      value: apiGwLogsRole.roleArn,
      description: 'ARN of the IAM Role used by API Gateway to push logs to CloudWatch',
    });
  }
}
