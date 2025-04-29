import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import logger from '../utils/logger'; // Import the shared logger

const dynamoDBClient = new DynamoDBClient({});
const tableName = process.env.AGENT_REGISTRY_TABLE_NAME;
const HEARTBEAT_TTL_EXTENSION_SECONDS = 15 * 60; // Extend TTL by 15 minutes on heartbeat

export const handler = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
    const connectionId = event.requestContext.connectionId;
    const receivedTime = new Date();
    const log = logger.child({ connectionId, action: 'heartbeat', receivedAt: receivedTime.toISOString() });
    log.info('Heartbeat received');

    if (!tableName) {
        log.error({ errorCode: 'ORC-CFG-1001' }, 'AGENT_REGISTRY_TABLE_NAME environment variable not set.');
        // Do not send error back to client for heartbeat failure, just log
        return { statusCode: 200, body: 'Heartbeat processed (internal error).' };
    }

    const newTtl = Math.floor(receivedTime.getTime() / 1000) + HEARTBEAT_TTL_EXTENSION_SECONDS;

    const updateParams = {
        TableName: tableName,
        Key: {
            connectionId: { S: connectionId },
        },
        UpdateExpression: 'SET lastHeartbeat = :ts, #ttl = :ttlValue, #status = :statusValue',
        ExpressionAttributeNames: {
            '#ttl': 'ttl',
             '#status': 'status',
        },
        ExpressionAttributeValues: {
            ':ts': { S: receivedTime.toISOString() },
            ':ttlValue': { N: String(newTtl) },
             ':statusValue': { S: 'active' } // Mark as active on heartbeat
        },
        ConditionExpression: 'attribute_exists(connectionId)', // Only update if the connection exists
    };

    try {
        await dynamoDBClient.send(new UpdateItemCommand(updateParams));
        log.info('Successfully updated agent heartbeat and TTL');
        return { statusCode: 200, body: 'Heartbeat acknowledged.' };
    } catch (error: any) {
        if (error.name === 'ConditionalCheckFailedException') {
             log.warn({ errorCode: 'ORC-APP-1001' }, 'Heartbeat received for unknown or disconnected connectionId.');
             // Potentially send a message back instructing the client to reconnect? For now, just acknowledge.
        } else {
            log.error({ errorCode: 'ORC-DEP-1003', error: error.message, stack: error.stack }, 'Error updating agent heartbeat in Agent Registry');
        }
        // Do not send error back to client for heartbeat failure, just log and acknowledge
        return { statusCode: 200, body: 'Heartbeat processed (internal error).' };
    }
}; 