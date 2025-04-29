import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { AgentInfo } from '../utils/types';
import logger from '../utils/logger'; // Import the shared logger

const dynamoDBClient = new DynamoDBClient({});
const tableName = process.env.AGENT_REGISTRY_TABLE_NAME;

export const handler = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
    const connectionId = event.requestContext.connectionId;
    const connectTime = new Date().toISOString();
    const log = logger.child({ connectionId, connectTime }); // Create child logger with context
    log.info('Connect event received');

    if (!tableName) {
        // Use specific error code
        log.error({ errorCode: 'ORC-CFG-1001' }, 'AGENT_REGISTRY_TABLE_NAME environment variable not set.');
        return { statusCode: 500, body: 'Internal Server Error: Table name not configured.' };
    }

    const putParams = {
        TableName: tableName,
        Item: {
            connectionId: { S: connectionId },
            connectedAt: { S: connectTime },
            status: { S: 'connected' }, // Initial status
            // Add TTL attribute (e.g., 24 hours from now)
            ttl: { N: String(Math.floor(Date.now() / 1000) + 24 * 60 * 60) }
        },
    };

    try {
        await dynamoDBClient.send(new PutItemCommand(putParams));
        log.info('Successfully stored connection ID in Agent Registry');
        return { statusCode: 200, body: 'Connected.' };
    } catch (error: any) {
        // Use specific error code for DynamoDB failure
        log.error({ errorCode: 'ORC-DEP-1002', error: error.message, stack: error.stack }, 'Error storing connection ID in Agent Registry');
        return { statusCode: 500, body: 'Failed to connect.' };
    }
};
