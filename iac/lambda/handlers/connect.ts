import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { AgentInfo } from '../utils/types';

const dynamoDBClient = new DynamoDBClient({});
const tableName = process.env.AGENT_REGISTRY_TABLE_NAME;

export const handler = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
    const connectionId = event.requestContext.connectionId;
    const connectTime = new Date().toISOString();
    console.log(`Connect event received for connection ID: ${connectionId} at ${connectTime}`);

    if (!tableName) {
        console.error('AGENT_REGISTRY_TABLE_NAME environment variable not set.');
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
        console.log(`Successfully stored connection ID: ${connectionId}`);
        return { statusCode: 200, body: 'Connected.' };
    } catch (error) {
        console.error('Error storing connection ID:', error);
        return { statusCode: 500, body: 'Failed to connect.' };
    }
};
