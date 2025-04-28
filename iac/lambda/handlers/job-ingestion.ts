import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { JobData } from '../utils/types';
import { dispatchJob } from '../utils/job-dispatcher';
// import { DynamoDBClient } from '@aws-sdk/client-dynamodb'; // For Job Repository

// const jobRepositoryTableName = process.env.JOB_REPOSITORY_TABLE_NAME;
const agentRegistryTableName = process.env.AGENT_REGISTRY_TABLE_NAME;
const webSocketApiEndpoint = process.env.WEBSOCKET_API_ENDPOINT;

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const requestId = uuidv4();
    console.log(`Received job ingestion request: ${requestId}, Body: ${event.body}`);

    if (!agentRegistryTableName || !webSocketApiEndpoint) {
        console.error('Missing required environment variables: AGENT_REGISTRY_TABLE_NAME or WEBSOCKET_API_ENDPOINT');
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Internal server configuration error.', requestId }),
        };
    }

    // Basic validation
    if (!event.body) {
        return {
            statusCode: 400,
            body: JSON.stringify({ message: 'Missing request body.', requestId }),
        };
    }

    try {
        const jobRequest = JSON.parse(event.body);

        // --- TODO: Task 7.3: Implement request validation ---
        // Validate url, method, headers, body, etc.
        const { url, method, headers, body, bodyEncoding, timeoutMs } = jobRequest;

        if (!url || typeof url !== 'string') {
            return { statusCode: 400, body: JSON.stringify({ message: 'Invalid request: Missing or invalid url', requestId }) };
        }
        // Basic URL validation
        try {
            new URL(url);
        } catch (e) {
            return { statusCode: 400, body: JSON.stringify({ message: 'Invalid request: Malformed URL', requestId }) };
        }

        if (!method || typeof method !== 'string' || !['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
            return { statusCode: 400, body: JSON.stringify({ message: `Invalid request: Missing or invalid method: ${method}`, requestId }) };
        }

        if (headers && typeof headers !== 'object') {
            return { statusCode: 400, body: JSON.stringify({ message: 'Invalid request: headers must be an object', requestId }) };
        }

        if (body && typeof body !== 'string') {
            return { statusCode: 400, body: JSON.stringify({ message: 'Invalid request: body must be a string (potentially Base64 encoded)', requestId }) };
        }

        if (bodyEncoding && !['base64', 'utf8'].includes(bodyEncoding)) {
            return { statusCode: 400, body: JSON.stringify({ message: `Invalid request: invalid bodyEncoding: ${bodyEncoding}. Must be 'base64' or 'utf8'.`, requestId }) };
        }

        if (timeoutMs && (typeof timeoutMs !== 'number' || timeoutMs <= 0)) {
            return { statusCode: 400, body: JSON.stringify({ message: 'Invalid request: timeoutMs must be a positive number', requestId }) };
        }

        const jobId = uuidv4(); // Generate unique job ID
        console.log(`Generated Job ID: ${jobId} for request ${requestId}`);

        // --- TODO: Create JobData object ---
        const newJob: JobData = {
            jobId,
            url: jobRequest.url,
            method: jobRequest.method.toUpperCase(),
            headers: jobRequest.headers || {},
            body: jobRequest.body, // Agent expects string (potentially base64)
            status: 'pending',
            createdAt: new Date().toISOString(),
            timeoutMs: jobRequest.timeoutMs || 30000,
        };

        // --- TODO: Task 7.4: Integrate with dispatchJob ---
        // 1. Store job in JobRepository (if implemented)
        // 2. Call dispatchJob(newJob)
        console.log(`Attempting to dispatch job ${jobId} via endpoint ${webSocketApiEndpoint}...`);
        const dispatched = await dispatchJob(newJob, webSocketApiEndpoint);

        // --- TODO: Task 8: Implement synchronous wait ---
        // For now, just acknowledge receipt and initiation

        return {
            statusCode: 202, // Accepted
            body: JSON.stringify({
                message: dispatched ? 'Job accepted and dispatch initiated.' : 'Job accepted but failed to initiate dispatch.',
                jobId: jobId,
                requestId: requestId,
                dispatched: dispatched // Indicate if dispatch was initially successful
            }),
        };

    } catch (error: any) {
        console.error(`Error processing job ingestion request ${requestId}:`, error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Failed to process job request.', error: error.message, requestId }),
        };
    }
}; 