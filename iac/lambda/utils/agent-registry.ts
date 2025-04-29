import { DynamoDBClient, QueryCommand, UpdateItemCommand, ReturnValue, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { AgentInfo } from './types';
import logger from './logger';

const dynamoDb = new DynamoDBClient({});
const TABLE_NAME = process.env.AGENT_REGISTRY_TABLE_NAME;
const STATUS_INDEX_NAME = 'StatusIndex'; // Make sure this matches the GSI name in CDK

/**
 * Finds an available agent from the registry.
 * TODO: Implement more sophisticated selection strategies (round-robin, geo-based, etc.)
 */
export async function findAvailableAgent(): Promise<AgentInfo | null> {
    if (!TABLE_NAME) {
        console.error('AGENT_REGISTRY_TABLE_NAME environment variable not set.');
        throw new Error('Agent registry table name not configured.');
    }

    try {
        const params = {
            TableName: TABLE_NAME,
            IndexName: STATUS_INDEX_NAME,
            KeyConditionExpression: '#status = :statusVal',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: marshall({ ':statusVal': 'available' }),
            // Limit the query for efficiency, maybe select randomly later
            Limit: 10, // Adjust as needed
        };

        const { Items } = await dynamoDb.send(new QueryCommand(params));

        if (!Items || Items.length === 0) {
            console.log('No available agents found.');
            return null;
        }

        // Simple random selection for now
        const randomIndex = Math.floor(Math.random() * Items.length);
        const selectedAgent = unmarshall(Items[randomIndex]) as AgentInfo;
        console.log(`Selected available agent: ${selectedAgent.agentId || selectedAgent.connectionId}`);
        return selectedAgent;

    } catch (error) {
        console.error('Error querying for available agents:', error);
        throw error;
    }
}

/**
 * Marks an agent as busy with a specific job.
 */
export async function markAgentAsBusy(connectionId: string, jobId: string): Promise<boolean> {
    if (!TABLE_NAME) {
        console.error('AGENT_REGISTRY_TABLE_NAME environment variable not set.');
        return false;
    }

    try {
        const params = {
            TableName: TABLE_NAME,
            Key: marshall({ connectionId }),
            UpdateExpression: 'SET #status = :statusVal, currentJobId = :jobId, updatedAt = :updatedAt',
            ConditionExpression: 'attribute_exists(connectionId) AND #status = :availableStatus', // Ensure agent exists and is available
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: marshall({
                ':statusVal': 'busy',
                ':jobId': jobId,
                ':updatedAt': new Date().toISOString(),
                ':availableStatus': 'available'
            }),
            ReturnValues: ReturnValue.UPDATED_NEW,
        };
        await dynamoDb.send(new UpdateItemCommand(params));
        console.log(`Successfully marked agent ${connectionId} as busy with job ${jobId}`);
        return true;
    } catch (error: any) {
        if (error.name === 'ConditionalCheckFailedException') {
            console.warn(`Agent ${connectionId} could not be marked busy (not found or not available).`);
        } else {
            console.error(`Error marking agent ${connectionId} as busy:`, error);
        }
        return false;
    }
}

/**
 * Marks an agent as available.
 */
export async function markAgentAsAvailable(connectionId: string): Promise<boolean> {
    if (!TABLE_NAME) {
        console.error('AGENT_REGISTRY_TABLE_NAME environment variable not set.');
        return false;
    }

    try {
        const params = {
            TableName: TABLE_NAME,
            Key: marshall({ connectionId }),
            UpdateExpression: 'SET #status = :statusVal REMOVE currentJobId SET updatedAt = :updatedAt',
            ConditionExpression: 'attribute_exists(connectionId)', // Agent must exist
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: marshall({
                ':statusVal': 'available',
                ':updatedAt': new Date().toISOString(),
            }),
            ReturnValues: ReturnValue.UPDATED_NEW,
        };
        await dynamoDb.send(new UpdateItemCommand(params));
        console.log(`Successfully marked agent ${connectionId} as available.`);
        return true;
    } catch (error) {
        console.error(`Error marking agent ${connectionId} as available:`, error);
        return false;
    }
}

/**
 * Deletes an agent connection record from the registry.
 * Useful when a connection is confirmed to be gone (e.g., GoneException).
 */
export async function deleteAgentConnection(connectionId: string): Promise<boolean> {
    if (!TABLE_NAME) {
        console.error('AGENT_REGISTRY_TABLE_NAME environment variable not set.');
        return false;
    }

    try {
        const params = {
            TableName: TABLE_NAME,
            Key: marshall({ connectionId }),
            // Optional: ConditionExpression: 'attribute_exists(connectionId)'
        };
        await dynamoDb.send(new DeleteItemCommand(params)); // Use DeleteItemCommand
        console.log(`Successfully deleted agent connection record ${connectionId}`);
        return true;
    } catch (error) {
        console.error(`Error deleting agent connection record ${connectionId}:`, error);
        return false; // Indicate failure
    }
}

// New function to update agent status based on heartbeat/status message
export async function updateAgentStatusInRegistry(connectionId: string, statusData: any): Promise<boolean> {
    const log = logger.child({ connectionId, function: 'updateAgentStatusInRegistry', statusData });
    const tableName = process.env.AGENT_REGISTRY_TABLE_NAME;
    if (!tableName) {
        log.error({ errorCode: 'ORC-CFG-1001' }, 'AGENT_REGISTRY_TABLE_NAME not set');
        return false;
    }

    // Construct update expression dynamically based on provided statusData
    let updateExpression = 'SET lastStatusUpdate = :lastUpdate';
    const expressionAttributeValues: any = {
        ':lastUpdate': { S: new Date().toISOString() }
    };
    const expressionAttributeNames: any = {};

    if (statusData.status !== undefined) {
        updateExpression += ', #status = :status';
        expressionAttributeNames['#status'] = 'status'; // Alias reserved keyword
        expressionAttributeValues[':status'] = { S: statusData.status };
    }
    if (statusData.activeJobCount !== undefined) {
        updateExpression += ', activeJobCount = :jobCount';
        expressionAttributeValues[':jobCount'] = { N: String(statusData.activeJobCount) };
    }
    if (statusData.uptimeSeconds !== undefined) {
        updateExpression += ', agentUptimeSeconds = :uptime';
        expressionAttributeValues[':uptime'] = { N: String(statusData.uptimeSeconds) };
    }
     if (statusData.platform !== undefined) {
        updateExpression += ', agentPlatform = :platform';
        expressionAttributeValues[':platform'] = { S: statusData.platform };
    }
    if (statusData.nodeVersion !== undefined) {
        updateExpression += ', agentNodeVersion = :nodeVersion';
        expressionAttributeValues[':nodeVersion'] = { S: statusData.nodeVersion };
    }
    // Add more fields as needed

    const command = new UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ connectionId }),
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
        ExpressionAttributeValues: expressionAttributeValues,
        ConditionExpression: 'attribute_exists(connectionId)', // Only update if the agent record exists
        ReturnValues: 'NONE'
    });

    try {
        await dynamoDb.send(command);
        log.info('Successfully updated agent status in registry.');
        return true;
    } catch (error: any) {
        if (error.name === 'ConditionalCheckFailedException') {
            log.warn({ errorCode: 'ORC-JOB-1000' /* Or specific code */ }, 'Attempted to update status for non-existent/disconnected agent.');
        } else {
            log.error({ errorCode: 'ORC-DEP-1002', error: error.message, stack: error.stack }, 'Error updating agent status in registry.');
        }
        return false;
    }
} 