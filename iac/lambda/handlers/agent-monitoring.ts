import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient, QueryCommand, ScanCommand, QueryCommandInput, ScanCommandInput } from '@aws-sdk/client-dynamodb';
import { unmarshall as defaultUnmarshall } from '@aws-sdk/util-dynamodb'; // Rename default import
import logger from '../utils/logger'; // Use default import
import { AgentInfo } from '../utils/types'; // Assuming AgentInfo type exists

// Default client initialized here
const defaultDynamoDBClient = new DynamoDBClient({});

const tableName = process.env.AGENT_REGISTRY_TABLE_NAME;
const GSI_NAME = 'StatusIndex'; // Define GSI name as constant
const DEFAULT_LIMIT = 20; // Default number of items per page

interface HandlerDependencies {
    dbClient?: DynamoDBClient;
    unmarshall?: (item: Record<string, any>) => Record<string, any>;
}

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
 * Accepts optional dependencies for testing.
 */
export const handler = async (
    event: APIGatewayProxyEventV2,
    dependencies: HandlerDependencies = {} // Accept optional dependencies
): Promise<APIGatewayProxyResultV2> => {
    // Use provided dependencies or defaults
    const dynamoDBClient = dependencies.dbClient || defaultDynamoDBClient;
    const unmarshall = dependencies.unmarshall || defaultUnmarshall;

    const log = logger.child({ requestId: event.requestContext?.requestId, path: event.rawPath });
    log.info('Received agent monitoring request', { queryStringParameters: event.queryStringParameters });

    if (!tableName) {
        log.error({ errorCode: 'ORC-CFG-1001' }, 'AGENT_REGISTRY_TABLE_NAME environment variable not set.');
        return { statusCode: 500, body: JSON.stringify({ message: 'Internal Server Error: Table name not configured.' }) };
    }

    const statusFilter = event.queryStringParameters?.status;
    const limitParam = event.queryStringParameters?.limit;
    const nextTokenParam = event.queryStringParameters?.nextToken;

    // --- Status filter validation (Added based on tests) ---
    const validStatuses = ['active', 'busy', 'idle', 'error', 'terminating']; // Define valid statuses
    if (statusFilter && !validStatuses.includes(statusFilter)) {
        log.warn({ statusFilter }, 'Invalid status filter provided.');
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Invalid status filter. Must be one of: ${validStatuses.join(', ')}` }),
        };
    }
    // --- End status filter validation ---

    const limit = limitParam ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
    if (isNaN(limit) || limit <= 0) {
        log.warn({ limitParam }, 'Invalid limit parameter received.');
        return { statusCode: 400, body: JSON.stringify({ message: 'Invalid limit parameter. Must be a positive integer.' }) };
    }

    let exclusiveStartKey: Record<string, any> | undefined;
    if (nextTokenParam) {
        try {
            const decoded = Buffer.from(nextTokenParam, 'base64').toString('utf-8');
            exclusiveStartKey = JSON.parse(decoded);
        } catch (error) {
            log.warn({ tokenSnippet: nextTokenParam.substring(0, 50) }, 'Invalid nextToken format received.');
            return {
                statusCode: 400,
                body: JSON.stringify({ message: 'Invalid nextToken format.' }),
            };
        }
    }

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
        };
    } else {
        log.info('Scanning AgentRegistryTable');
        useQuery = false;
        commandInput = {
            TableName: tableName,
            Limit: limit,
            ExclusiveStartKey: exclusiveStartKey,
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
        // Improved error code based on tests and context
        const errorCode = useQuery ? 'ORC-DEP-1002' : 'ORC-DEP-1002'; // Example: Same code for Scan/Query DB error
        log.error({ errorCode, error: error.message, stack: error.stack, useQuery, statusFilter }, 'Error querying/scanning Agent Registry Table');
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            // Generic message for client
            body: JSON.stringify({ message: 'Internal Server Error retrieving agent data.' }),
        };
    }
}; 