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
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources'; // Import for SQS trigger
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'; // Import cloudwatch for metrics permissions

// Placeholder Lambda ARN (replace in later tasks)
const PLACEHOLDER_LAMBDA_URI = 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:placeholderFunction/invocations';

export class OrchestratorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Shared IAM Role for Lambda Handlers ---
    // (Consolidated role definition for simplicity)
    const lambdaHandlerRole = new iam.Role(this, 'OrchestratorLambdaHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Allow managing WebSocket connections
    lambdaHandlerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['execute-api:ManageConnections'],
      resources: [`arn:aws:execute-api:${this.region}:${this.account}:*/*`], // Broad for now
    }));

    // Allow SQS access (send/receive/delete for temporary queues)
    lambdaHandlerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'sqs:SendMessage',
        'sqs:ReceiveMessage',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes',
        'sqs:CreateQueue', // Needed for sync flow temporary queues
        'sqs:DeleteQueue', // Needed for sync flow temporary queues
      ],
      resources: ['*'], // Restrict in production if possible
    }));

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
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // Grant read/write permissions to the shared role
    agentRegistryTable.grantReadWriteData(lambdaHandlerRole);

    // --- Job Repository DynamoDB Table (Placeholder) ---
    // ... (commented out)

    // --- Dead Letter Queue for Orchestrator Input ---
    const orchestratorInputDLQ = new sqs.Queue(this, 'OrchestratorInputDLQ', {
      queueName: `OrchestratorInputDLQ-${this.stackName}.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    // --- Orchestrator Input SQS Queue (FIFO) ---
    const orchestratorInputQueue = new sqs.Queue(this, 'OrchestratorInputQueue', {
      queueName: `OrchestratorInputQueue-${this.stackName}.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: orchestratorInputDLQ,
        maxReceiveCount: 5,
      },
    });
    // Grant send permissions to the shared role (for job ingestion)
    orchestratorInputQueue.grantSendMessages(lambdaHandlerRole);
    // Grant consume permissions to the shared role (for dispatcher)
    orchestratorInputQueue.grantConsumeMessages(lambdaHandlerRole);

    // --- Sync Job Mapping DynamoDB Table ---
    const syncJobMappingTable = new dynamodb.Table(this, 'SyncJobMappingTable', {
        tableName: 'distributed-res-proxy-sync-job-map',
        partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        timeToLiveAttribute: 'ttl',
    });
    // Grant read/write permissions to the shared role
    syncJobMappingTable.grantReadWriteData(lambdaHandlerRole);

    // --- Lambda Functions Environment Variables ---
    const lambdaEnvironment = {
      AGENT_API_KEYS_SECRET_ARN: agentApiKeysSecret.secretArn,
      AGENT_REGISTRY_TABLE_NAME: agentRegistryTable.tableName,
      ORCHESTRATOR_QUEUE_URL: orchestratorInputQueue.queueUrl,
      SYNC_JOB_MAPPING_TABLE_NAME: syncJobMappingTable.tableName,
      WEBSOCKET_API_ENDPOINT: '' // This will be set later after WebSocket API is created
      // JOB_REPOSITORY_TABLE_NAME: jobRepositoryTable.tableName, // Uncomment when job repo is added
    };

    // --- Lambda Function Definitions ---

    const connectHandler = new lambda_nodejs.NodejsFunction(this, 'ConnectHandler', {
      entry: path.join(__dirname, '../lambda/handlers/connect.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_LATEST,
      role: lambdaHandlerRole, // Use shared role
      environment: lambdaEnvironment,
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
      role: lambdaHandlerRole, // Use shared role
      environment: lambdaEnvironment,
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
      role: lambdaHandlerRole, // Use shared role
      environment: lambdaEnvironment,
    });
    new logs.LogGroup(this, 'DefaultHandlerLogGroup', {
      logGroupName: `/aws/lambda/${defaultHandler.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const jobIngestionHandler = new lambda_nodejs.NodejsFunction(this, 'JobIngestionHandler', {
      entry: path.join(__dirname, '../lambda/handlers/job-ingestion.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_LATEST,
      role: lambdaHandlerRole, // Use shared role
      environment: lambdaEnvironment,
    });
    new logs.LogGroup(this, 'JobIngestionHandlerLogGroup', {
      logGroupName: `/aws/lambda/${jobIngestionHandler.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const orchestratorDispatcherHandler = new lambda_nodejs.NodejsFunction(this, 'OrchestratorDispatcherHandler', {
      entry: path.join(__dirname, '../lambda/handlers/orchestrator-dispatcher.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_LATEST,
      role: lambdaHandlerRole, // Use shared role
      environment: lambdaEnvironment,
    });
    // Add SQS event source
    orchestratorDispatcherHandler.addEventSource(new SqsEventSource(orchestratorInputQueue, {
        batchSize: 10, // Adjust as needed
        reportBatchItemFailures: true, // Important for error handling
    }));
    new logs.LogGroup(this, 'OrchestratorDispatcherLogGroup', {
        logGroupName: `/aws/lambda/${orchestratorDispatcherHandler.functionName}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // <<< START: Add Metrics Handler >>>
    const metricsHandler = new lambda_nodejs.NodejsFunction(this, 'MetricsHandler', {
      entry: path.join(__dirname, '../lambda/handlers/metrics.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_LATEST,
      role: lambdaHandlerRole, // Basic execution role is likely sufficient
      environment: lambdaEnvironment, // Pass environment just in case (though not strictly needed now)
    });
    new logs.LogGroup(this, 'MetricsHandlerLogGroup', {
      logGroupName: `/aws/lambda/${metricsHandler.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // <<< END: Add Metrics Handler >>>

    // <<< START: Add Agent Monitoring Handler >>>
    const agentMonitoringHandler = new lambda_nodejs.NodejsFunction(this, 'AgentMonitoringHandler', {
      entry: path.join(__dirname, '../lambda/handlers/agent-monitoring.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_LATEST,
      role: lambdaHandlerRole, // Reuse shared role initially
      environment: lambdaEnvironment, 
    });
    // Grant read access to the Agent Registry table
    agentRegistryTable.grantReadData(agentMonitoringHandler);
    new logs.LogGroup(this, 'AgentMonitoringHandlerLogGroup', {
      logGroupName: `/aws/lambda/${agentMonitoringHandler.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // <<< END: Add Agent Monitoring Handler >>>

    // <<< START: Add Heartbeat Handler >>>
    const heartbeatHandler = new lambda_nodejs.NodejsFunction(this, 'HeartbeatHandler', {
      entry: path.join(__dirname, '../lambda/handlers/heartbeat.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_LATEST,
      role: lambdaHandlerRole, // Reuse shared role (needs DynamoDB write)
      environment: lambdaEnvironment, 
    });
    // Grant write access to the Agent Registry table (UpdateItem)
    agentRegistryTable.grantReadWriteData(heartbeatHandler);
    new logs.LogGroup(this, 'HeartbeatHandlerLogGroup', {
      logGroupName: `/aws/lambda/${heartbeatHandler.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // <<< END: Add Heartbeat Handler >>>

    // --- WebSocket API Gateway ---
    const webSocketApi = new apigwv2.WebSocketApi(this, 'ResidentialProxyWebSocketApi', {
      apiName: 'ResidentialProxyWebSocketApi',
      description: 'WebSocket API for Distributed Residential Proxy System',
      routeSelectionExpression: '$request.body.action',
      connectRouteOptions: { integration: new WebSocketLambdaIntegration('ConnectIntegration', connectHandler) },
      disconnectRouteOptions: { integration: new WebSocketLambdaIntegration('DisconnectIntegration', disconnectHandler) },
    });
    webSocketApi.addRoute('$default', {
      integration: new WebSocketLambdaIntegration('DefaultIntegration', defaultHandler),
    });

    // <<< START: Add Heartbeat Route >>>
    webSocketApi.addRoute('heartbeat', {
        integration: new WebSocketLambdaIntegration('HeartbeatIntegration', heartbeatHandler),
    });
    // <<< END: Add Heartbeat Route >>>

    // --- Deployment Stage ---
    const stage = new WebSocketStage(this, 'DevStage', {
      webSocketApi,
      stageName: 'dev',
      autoDeploy: true,
    });
    // Update Lambda environment with the final WebSocket URL
    const webSocketUrl = stage.url;
    [connectHandler, disconnectHandler, defaultHandler, jobIngestionHandler, orchestratorDispatcherHandler, metricsHandler, agentMonitoringHandler].forEach(handler => {
         handler.addEnvironment('WEBSOCKET_API_ENDPOINT', webSocketUrl);
    });

    // <<< START: Add HeartbeatHandler to Environment Update >>>
    heartbeatHandler.addEnvironment('WEBSOCKET_API_ENDPOINT', webSocketUrl);
    // <<< END: Add HeartbeatHandler to Environment Update >>>

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
        corsPreflight: { 
            allowHeaders: ['*'], // More permissive for now
            allowMethods: [apigw_http.CorsHttpMethod.POST, apigw_http.CorsHttpMethod.GET, apigw_http.CorsHttpMethod.OPTIONS],
            allowOrigins: ['*'],
        },
    });

    // Add routes to HTTP API
    httpApi.addRoutes({
      path: '/jobs',
      methods: [ apigw_http.HttpMethod.POST ],
      integration: new HttpLambdaIntegration('JobIngestionIntegration', jobIngestionHandler),
    });

    // <<< START: Add Metrics Route >>>
    httpApi.addRoutes({
        path: '/metrics',
        methods: [ apigw_http.HttpMethod.GET ],
        integration: new HttpLambdaIntegration('MetricsIntegration', metricsHandler),
    });
    // <<< END: Add Metrics Route >>>

    // <<< START: Add Agent Monitoring Route >>>
    httpApi.addRoutes({
        path: '/agents',
        methods: [ apigw_http.HttpMethod.GET ],
        integration: new HttpLambdaIntegration('AgentMonitoringIntegration', agentMonitoringHandler),
        // TODO: Add authorizer once authentication is implemented for this endpoint (Subtask 9.10)
    });
    // <<< END: Add Agent Monitoring Route >>>

    // --- Grant Secrets Manager Read Permissions ---
    agentApiKeysSecret.grantRead(connectHandler);
    // Ensure disconnect and default handlers also have necessary permissions if they interact with registry
    agentRegistryTable.grantReadWriteData(disconnectHandler);
    agentRegistryTable.grantReadWriteData(defaultHandler);
    agentRegistryTable.grantReadWriteData(orchestratorDispatcherHandler);
    // Grant sync table permissions
    syncJobMappingTable.grantReadWriteData(defaultHandler);
    syncJobMappingTable.grantReadWriteData(orchestratorDispatcherHandler); // Dispatcher needs to write mapping
    syncJobMappingTable.grantReadWriteData(jobIngestionHandler); // Job ingestion needs to write mapping

    // Grant permission for dispatcher to post back to WebSocket connections
    const webSocketPolicy = new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [
            `arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.apiId}/${stage.stageName}/POST/@connections/*`
        ],
        effect: iam.Effect.ALLOW,
    });
    orchestratorDispatcherHandler.addToRolePolicy(webSocketPolicy);
    defaultHandler.addToRolePolicy(webSocketPolicy); // Default handler might also need to send messages

    // Grant CloudWatch PutMetricData permissions (if using custom metrics pushed from Lambda)
    lambdaHandlerRole.addToPolicy(new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'], // Can optionally restrict namespace
    }));

    // --- Outputs ---
    new cdk.CfnOutput(this, 'WebSocketApiUrl', {
      value: stage.url,
      description: 'The URL of the WebSocket API',
    });
    new cdk.CfnOutput(this, 'HttpApiUrl', {
      value: httpApi.url!,
      description: 'The URL of the HTTP API Gateway for job ingestion',
    });
     new cdk.CfnOutput(this, 'OrchestratorInputQueueUrl', {
      value: orchestratorInputQueue.queueUrl,
      description: 'URL of the Orchestrator Input SQS Queue',
    });
    new cdk.CfnOutput(this, 'OrchestratorInputQueueArn', {
      value: orchestratorInputQueue.queueArn,
      description: 'ARN of the Orchestrator Input SQS Queue',
    });

  }
}
