import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import logger from '../utils/logger'; // Ensure correct import

const dynamoDb = new DynamoDBClient({});
const AGENT_REGISTRY_TABLE_NAME = process.env.AGENT_REGISTRY_TABLE_NAME;
const SYNC_JOB_MAPPING_TABLE_NAME = process.env.SYNC_JOB_MAPPING_TABLE_NAME;

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    // Create a logger instance for this invocation if needed, or use the base logger
    const log = logger; // Using base logger is fine for health checks
    log.info('Health check requested');

    const checks = [
        { name: 'AgentRegistryTable', tableName: AGENT_REGISTRY_TABLE_NAME },
        { name: 'SyncJobMappingTable', tableName: SYNC_JOB_MAPPING_TABLE_NAME },
        // Add other critical dependency checks here (e.g., SQS queue connectivity)
    ];

    let isHealthy = true;
    const checkResults: { [key: string]: string } = {};

    for (const check of checks) {
        const checkLog = log.child({ healthCheckName: check.name });
        if (!check.tableName) {
            checkLog.error({ errorCode: 'ORC-CFG-1001', tableNameEnvVar: check.name }, `Configuration Error: Environment variable not set.`);
            checkResults[check.name] = 'Configuration Error';
            isHealthy = false;
            continue;
        }
        try {
            await dynamoDb.send(new DescribeTableCommand({ TableName: check.tableName }));
            checkResults[check.name] = 'OK';
            checkLog.info(`Dependency check OK.`);
        } catch (error: any) {
            checkLog.error({ errorCode: 'ORC-DEP-1000', tableName: check.tableName, error: error.message, stack: error.stack }, `Dependency check failed.`);
            checkResults[check.name] = 'Error';
            isHealthy = false;
        }
    }

    if (isHealthy) {
        log.info({ checkResults }, 'Health check passed');
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'healthy', checks: checkResults }),
        };
    } else {
        log.warn({ checkResults }, 'Health check failed');
        return {
            statusCode: 503,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'unhealthy', checks: checkResults }),
        };
    }
} 