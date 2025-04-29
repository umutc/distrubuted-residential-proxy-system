import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient, QueryCommand, ScanCommand, QueryCommandInput, ScanCommandInput } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import logger from '../utils/logger'; // Use default import
import { AgentInfo } from '../utils/types'; // Assuming AgentInfo type exists

const dynamoDBClient = new DynamoDBClient({});
const tableName = process.env.AGENT_REGISTRY_TABLE_NAME;
const GSI_NAME = 'StatusIndex'; // Define GSI name as constant
const DEFAULT_LIMIT = 20; // Default number of items per page

/**
 * Parses pagination token.
 */
const parseNextToken = (token: string | undefined): Record<string, any> | undefined => {
    if (!token) return undefined;
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        return JSON.parse(decoded);
    } catch (error) {
        logger.warn({ error, token }, 'Failed to parse nextToken');
        return undefined;
    }
};

/**
 * Creates pagination token.
 */
const createNextToken = (lastEvaluatedKey: Record<string, any> | undefined): string | null => {
    if (!lastEvaluatedKey) return null;
    try {
        const json = JSON.stringify(lastEvaluatedKey);
        return Buffer.from(json).toString('base64');
    } catch (error) {
        logger.error({ error, lastEvaluatedKey }, 'Failed to create nextToken');
        return null;
    }
};

/**
 * Handles GET requests to /agents for monitoring connected agents.
 * Supports filtering by status and pagination.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const log = logger.child({ requestId: event.requestContext?.requestId, path: event.rawPath });
    log.info('Received agent monitoring request', { queryStringParameters: event.queryStringParameters });

    if (!tableName) {
        log.error({ errorCode: 'ORC-CFG-1001' }, 'AGENT_REGISTRY_TABLE_NAME environment variable not set.');
        return { statusCode: 500, body: JSON.stringify({ message: 'Internal Server Error: Table name not configured.' }) };
    }

    const statusFilter = event.queryStringParameters?.status;
    const limitParam = event.queryStringParameters?.limit;
    const nextTokenParam = event.queryStringParameters?.nextToken;

    const limit = limitParam ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
    if (isNaN(limit) || limit <= 0) {
        return { statusCode: 400, body: JSON.stringify({ message: 'Invalid limit parameter.' }) };
    }

    const exclusiveStartKey = parseNextToken(nextTokenParam);

    let commandInput: QueryCommandInput | ScanCommandInput;
    let useQuery = false;

    if (statusFilter) {
        log.info({ statusFilter }, 'Querying AgentRegistryTable using StatusIndex');
        useQuery = true;
        commandInput = {
            TableName: tableName,
            IndexName: GSI_NAME,
            KeyConditionExpression: '#status = :statusVal',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':statusVal': { S: statusFilter } },
            Limit: limit,
            ExclusiveStartKey: exclusiveStartKey,
            // Consider adding ProjectionExpression if not all attributes are needed
        };
    } else {
        log.info('Scanning AgentRegistryTable');
        useQuery = false;
        commandInput = {
            TableName: tableName,
            Limit: limit,
            ExclusiveStartKey: exclusiveStartKey,
            // Consider adding ProjectionExpression and FilterExpression if needed
        };
    }

    try {
        const command = useQuery ? new QueryCommand(commandInput as QueryCommandInput) : new ScanCommand(commandInput as ScanCommandInput);
        const data = await dynamoDBClient.send(command);

        const agents = data.Items ? data.Items.map(item => unmarshall(item) as AgentInfo) : [];
        const nextToken = createNextToken(data.LastEvaluatedKey);

        log.info({ count: agents.length, hasMore: !!nextToken }, 'Successfully retrieved agent data');

        const response = {
            agents,
            nextToken,
        };

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(response),
        };
    } catch (error: any) {
        log.error({ errorCode: 'ORC-DEP-1004', error: error.message, stack: error.stack, useQuery, statusFilter }, 'Error querying/scanning Agent Registry Table');
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Internal server error retrieving agent data.' }),
        };
    }
}; 