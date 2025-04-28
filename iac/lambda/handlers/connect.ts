import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const dynamoDBClient = new DynamoDBClient({});
const tableName = process.env.AGENT_REGISTRY_TABLE_NAME;

export const handler = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
    const connectionId = event.requestContext.connectionId;
    console.log(`Connect event received for connection ID: ${connectionId}`);

    if (!tableName) {
        console.error('AGENT_REGISTRY_TABLE_NAME environment variable not set.');
        return { statusCode: 500, body: 'Internal Server Error: Table name not configured.' };
    }

    const putParams = {
        TableName: tableName,
        Item: {
            connectionId: { S: connectionId },
            // Add other relevant info if needed, e.g., connect time
            connectedAt: { S: new Date().toISOString() }
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
