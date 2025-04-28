import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { logger } from '../utils/logger'; // Assuming logger utility exists

const dynamoDb = new DynamoDBClient({});
const AGENT_REGISTRY_TABLE_NAME = process.env.AGENT_REGISTRY_TABLE_NAME;
const SYNC_JOB_MAPPING_TABLE_NAME = process.env.SYNC_JOB_MAPPING_TABLE_NAME;

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    logger.info('Health check requested');

    const checks = [
        { name: 'AgentRegistryTable', tableName: AGENT_REGISTRY_TABLE_NAME },
        { name: 'SyncJobMappingTable', tableName: SYNC_JOB_MAPPING_TABLE_NAME },
        // Add other critical dependency checks here (e.g., SQS queue connectivity)
    ];

    let isHealthy = true;
    const checkResults: { [key: string]: string } = {};

    for (const check of checks) {
        if (!check.tableName) {
            logger.error(`Health check failed: Environment variable for ${check.name} not set.`);
            checkResults[check.name] = 'Configuration Error';
            isHealthy = false;
            continue;
        }
        try {
            await dynamoDb.send(new DescribeTableCommand({ TableName: check.tableName }));
            checkResults[check.name] = 'OK';
            logger.debug(`${check.name} connection check OK.`);
        } catch (error) {
            logger.error(`Health check failed for ${check.name}:`, error);
            checkResults[check.name] = 'Error';
            isHealthy = false;
        }
    }

    if (isHealthy) {
        logger.info('Health check passed');
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'healthy', checks: checkResults }),
        };
    } else {
        logger.warn('Health check failed', { checks: checkResults });
        return {
            statusCode: 503,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'unhealthy', checks: checkResults }),
        };
    }
} 