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
// Use HttpApi and Lambda integrations for HTTP API
import * as apigw_http from '@aws-cdk/aws-apigatewayv2-alpha';
import { HttpLambdaIntegration } from '@aws-cdk/aws-apigatewayv2-integrations-alpha';
// Use this for Account-level settings like CloudWatch role
import * as apigw_classic from 'aws-cdk-lib/aws-apigateway';
import * as sqs from 'aws-cdk-lib/aws-sqs';

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
      timeToLiveAttribute: 'ttl',
    });

    // Add GSI for querying by status
    agentRegistryTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      // Optionally add a sort key if needed for further filtering, e.g., updatedAt
      // sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL, // Adjust as needed for query efficiency
    });

    // --- Job Repository DynamoDB Table (Placeholder for now) ---
    // Future Task: Define schema and enable this table
    /*
    const jobRepositoryTable = new dynamodb.Table(this, 'JobRepositoryTable', {
      tableName: 'distributed-res-proxy-job-repository',
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Adjust for production
      // timeToLiveAttribute: 'ttl', // Consider TTL for jobs
    });
    */

    // --- Orchestrator Input SQS Queue (FIFO) ---
    const orchestratorInputQueue = new sqs.Queue(this, 'OrchestratorInputQueue', {
      queueName: `OrchestratorInputQueue-${this.stackName}.fifo`,
      fifo: true, // Enable FIFO
      contentBasedDeduplication: true, // Automatic deduplication based on content
      visibilityTimeout: cdk.Duration.seconds(60), // Adjust based on expected processing time
      retentionPeriod: cdk.Duration.days(4),
      // encryption: sqs.QueueEncryption.KMS_MANAGED, // Consider encryption
      // deadLetterQueue: { // Configure DLQ later
      //   queue: deadLetterQueue,
      //   maxReceiveCount: 5,
      // },
    });

    // --- Sync Job Mapping DynamoDB Table ---
    const syncJobMappingTable = new dynamodb.Table(this, 'SyncJobMappingTable', {
        tableName: 'distributed-res-proxy-sync-job-map',
        partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY, // Adjust for production
        timeToLiveAttribute: 'ttl', // Enable TTL based on an attribute named 'ttl'
    });

    // --- Lambda Functions ---

    const connectHandler = new lambda_nodejs.NodejsFunction(this, 'ConnectHandler', {
      entry: path.join(__dirname, '../lambda/handlers/connect.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_LATEST,
      role: webSocketHandlerRole,
      environment: {
        AGENT_API_KEYS_SECRET_ARN: agentApiKeysSecret.secretArn,
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
      environment: {
        AGENT_REGISTRY_TABLE_NAME: agentRegistryTable.tableName,
        SYNC_JOB_MAPPING_TABLE_NAME: syncJobMappingTable.tableName, // <-- Add Sync Map Table Name
      },
    });
    new logs.LogGroup(this, 'DefaultHandlerLogGroup', {
      logGroupName: `/aws/lambda/${defaultHandler.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- WebSocket API Gateway ---
    const webSocketApi = new apigwv2.WebSocketApi(this, 'ResidentialProxyWebSocketApi', {
      apiName: 'ResidentialProxyWebSocketApi',
      description: 'WebSocket API for Distributed Residential Proxy System',
      routeSelectionExpression: '$request.body.action',
      connectRouteOptions: { integration: new WebSocketLambdaIntegration('ConnectIntegration', connectHandler) },
      disconnectRouteOptions: { integration: new WebSocketLambdaIntegration('DisconnectIntegration', disconnectHandler) },
    });

    // Add default route separately
    webSocketApi.addRoute('$default', {
      integration: new WebSocketLambdaIntegration('DefaultIntegration', defaultHandler),
    });

    // --- Deployment Stage ---
    const stage = new WebSocketStage(this, 'DevStage', {
      webSocketApi,
      stageName: 'dev',
      autoDeploy: true,
      // NOTE: Logging/throttling are configured on the underlying CfnStage
    });

    // Access the underlying CfnStage
    const cfnStage = stage.node.defaultChild as CfnStage;

    // Create a log group for API Gateway access logs
    const wsApiAccessLogGroup = new logs.LogGroup(this, 'WebSocketApiAccessLogGroup', {
      logGroupName: `/aws/apigateway/${webSocketApi.apiId}/${stage.stageName}/access`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Configure Access Logging on CfnStage
    cfnStage.accessLogSettings = {
      destinationArn: wsApiAccessLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        caller: '$context.identity.caller',
        user: '$context.identity.user',
        requestTime: '$context.requestTime',
        // httpMethod: '$context.httpMethod', // Not standard for WebSocket
        // resourcePath: '$context.resourcePath', // Not standard for WebSocket
        status: '$context.status',
        protocol: '$context.protocol',
        responseLength: '$context.responseLength',
        connectionId: '$context.connectionId',
        connectedAt: '$context.connectedAt',
        eventType: '$context.eventType',
        routeKey: '$context.routeKey',
        domainName: '$context.domainName',
        apiId: '$context.apiId'
      }),
    };

    // Configure Execution Logging and Metrics on CfnStage
    cfnStage.defaultRouteSettings = {
        loggingLevel: 'INFO', // Set desired logging level
        dataTraceEnabled: true, // Log full request/response data
        detailedMetricsEnabled: true, // Enable CloudWatch metrics
        // Throttling settings will use defaults if not specified here
    } as CfnStage.RouteSettingsProperty;

    // --- HTTP API Gateway for Job Ingestion ---
    const httpApi = new apigw_http.HttpApi(this, 'JobIngestionHttpApi', {
        apiName: 'ResidentialProxyJobIngestionApi',
        description: 'HTTP API for submitting proxy jobs',
        corsPreflight: { // Configure CORS if needed for browser clients
            allowHeaders: ['Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key'],
            allowMethods: [apigw_http.CorsHttpMethod.POST, apigw_http.CorsHttpMethod.OPTIONS],
            allowOrigins: ['*'], // Restrict in production
        },
        // Default stage is created automatically
    });

    // Define Job Ingestion Lambda *after* stage is defined to access stage.url
    const jobIngestionHandler = new lambda_nodejs.NodejsFunction(this, 'JobIngestionHandler', {
      entry: path.join(__dirname, '../lambda/handlers/job-ingestion.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_LATEST,
      role: webSocketHandlerRole, // Reuse role for now
      environment: {
        AGENT_REGISTRY_TABLE_NAME: agentRegistryTable.tableName,
        WEBSOCKET_API_ENDPOINT: stage.url, // Pass WebSocket URL to the handler
        ORCHESTRATOR_QUEUE_URL: orchestratorInputQueue.queueUrl, // <-- Add Orchestrator Queue URL
        // JOB_REPOSITORY_TABLE_NAME: jobRepositoryTable.tableName, // Add when table is enabled
      },
    });
    new logs.LogGroup(this, 'JobIngestionHandlerLogGroup', {
      logGroupName: `/aws/lambda/${jobIngestionHandler.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Orchestrator Job Dispatcher Lambda ---
    const orchestratorDispatcherHandler = new lambda_nodejs.NodejsFunction(this, 'OrchestratorDispatcherHandler', {
        entry: path.join(__dirname, '../lambda/handlers/orchestrator-dispatcher.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_LATEST,
        // Create a new role or reuse webSocketHandlerRole and add permissions
        role: webSocketHandlerRole, // Reusing role, ensure permissions are added below
        environment: {
            AGENT_REGISTRY_TABLE_NAME: agentRegistryTable.tableName,
            SYNC_JOB_MAPPING_TABLE_NAME: syncJobMappingTable.tableName,
            WEBSOCKET_API_ENDPOINT: stage.url, // Pass WebSocket URL (wss://...)
        },
        timeout: cdk.Duration.seconds(30), // Adjust as needed
    });
    // Add SQS Event Source Mapping
    orchestratorDispatcherHandler.addEventSourceMapping('OrchestratorInputQueueSource', {
        eventSourceArn: orchestratorInputQueue.queueArn,
        batchSize: 5, // Adjust batch size as needed
        // reportBatchItemFailures: true, // Enable partial batch failure reporting if handler supports it
    });
    new logs.LogGroup(this, 'OrchestratorDispatcherLogGroup', {
        logGroupName: `/aws/lambda/${orchestratorDispatcherHandler.functionName}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Grant Permissions ---
    agentApiKeysSecret.grantRead(connectHandler); // Grant connect Lambda permission to read the secret
    agentRegistryTable.grantReadWriteData(connectHandler);
    agentRegistryTable.grantReadWriteData(disconnectHandler);
    agentRegistryTable.grantReadWriteData(defaultHandler);
    // Grant Job Ingestion handler permissions
    agentRegistryTable.grantReadData(jobIngestionHandler); // Read agents

    // Grant Orchestrator Dispatcher handler permissions
    orchestratorInputQueue.grantConsumeMessages(orchestratorDispatcherHandler);
    agentRegistryTable.grantReadWriteData(orchestratorDispatcherHandler); // Find agents, mark busy/available
    syncJobMappingTable.grantReadWriteData(orchestratorDispatcherHandler); // Store sync mapping
    // Grant permission to post to WebSocket connections (already added to the shared role)
    // webSocketApi.grantManageConnections(orchestratorDispatcherHandler); // Ensure role allows this

    // Grant Default handler permissions for sync flow
    syncJobMappingTable.grantReadWriteData(defaultHandler); // Read/Delete sync mapping
    defaultHandler.addToRolePolicy(new iam.PolicyStatement({ // Send to temp response queues
      effect: iam.Effect.ALLOW,
      actions: ['sqs:SendMessage'],
      resources: [`arn:aws:sqs:${this.region}:${this.account}:job-response-*`],
    }));

    // --- Outputs ---

    // WebSocket API endpoint format: wss://{apiId}.execute-api.{region}.amazonaws.com/{stageName}
    new cdk.CfnOutput(this, 'WebSocketApiEndpoint', {
      value: stage.url,
      description: 'The endpoint URL for the WebSocket API',
    });

    new cdk.CfnOutput(this, 'WebSocketApiId', {
        value: webSocketApi.apiId,
        description: 'The ID of the WebSocket API',
    });

    // Output the API Gateway CloudWatch Logs Role ARN
    const apiGwLogsRole = new iam.Role(this, 'ApiGatewayLogsRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs'),
      ],
    });
    new apigw_classic.CfnAccount(this, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apiGwLogsRole.roleArn,
    }).node.addDependency(apiGwLogsRole);

    // Grant API Gateway permission to write to the log group
    wsApiAccessLogGroup.grantWrite(new iam.ServicePrincipal('apigateway.amazonaws.com'));

    // Grant Default handler permissions for sync flow
    syncJobMappingTable.grantReadWriteData(defaultHandler); // Read/Delete sync mapping
    defaultHandler.addToRolePolicy(new iam.PolicyStatement({ // Send to temp response queues
      effect: iam.Effect.ALLOW,
      actions: ['sqs:SendMessage'],
      resources: [`arn:aws:sqs:${this.region}:${this.account}:job-response-*`],
    }));

    // --- Outputs ---

    // WebSocket API endpoint format: wss://{apiId}.execute-api.{region}.amazonaws.com/{stageName}
    new cdk.CfnOutput(this, 'WebSocketApiEndpoint', {
      value: stage.url,
      description: 'The endpoint URL for the WebSocket API',
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

    new cdk.CfnOutput(this, 'WebSocketAccessLogGroup', {
        value: wsApiAccessLogGroup.logGroupName,
        description: 'CloudWatch Log Group for WebSocket Access Logs',
    });

    // HTTP API endpoint format: https://{apiId}.execute-api.{region}.amazonaws.com
    new cdk.CfnOutput(this, 'HttpApiEndpoint', {
        value: httpApi.url!,
        description: 'The endpoint URL for the HTTP Job Ingestion API',
    });

    new cdk.CfnOutput(this, 'AgentApiKeysSecretName', {
      value: agentApiKeysSecret.secretName,
      description: 'Name of the Secrets Manager secret storing agent API keys',
    });

    new cdk.CfnOutput(this, 'AgentRegistryTableNameOutput', {
        value: agentRegistryTable.tableName,
        description: 'Name of the DynamoDB table for agent registry',
    });

    new cdk.CfnOutput(this, 'SyncJobMappingTableNameOutput', {
        value: syncJobMappingTable.tableName,
        description: 'Name of the DynamoDB table for sync job mapping',
    });

    new cdk.CfnOutput(this, 'OrchestratorInputQueueUrl', {
        value: orchestratorInputQueue.queueUrl,
        description: 'URL of the SQS queue for orchestrator job input',
    });

    new cdk.CfnOutput(this, 'OrchestratorInputQueueArn', {
        value: orchestratorInputQueue.queueArn,
        description: 'ARN of the SQS queue for orchestrator job input',
    });
  }
}
