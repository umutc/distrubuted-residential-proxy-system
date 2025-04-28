import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { JobData } from '../utils/types';
import { dispatchJob } from '../utils/job-dispatcher';
import { SQSClient, CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, DeleteMessageCommand, GetQueueAttributesCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
// import { DynamoDBClient } from '@aws-sdk/client-dynamodb'; // For Job Repository

// const jobRepositoryTableName = process.env.JOB_REPOSITORY_TABLE_NAME;
const agentRegistryTableName = process.env.AGENT_REGISTRY_TABLE_NAME;
const webSocketApiEndpoint = process.env.WEBSOCKET_API_ENDPOINT;
const orchestratorQueueUrl = process.env.ORCHESTRATOR_QUEUE_URL; // Add this env var

const sqsClient = new SQSClient({});

// Constants for synchronous flow
const SYNC_TIMEOUT_BUFFER_MS = 2000; // Buffer before Lambda timeout
const SQS_WAIT_TIME_SECONDS = 20; // Max SQS long polling wait time
const MAX_SYNC_WAIT_MS = 28000; // Max time to wait for sync response (slightly less than 29s API GW limit)
const TEMP_QUEUE_RETENTION_SECONDS = '60'; // Keep queue for 1 min just in case

export const handler = async (event: APIGatewayProxyEventV2, context: Context): Promise<APIGatewayProxyResultV2> => {
    const requestId = uuidv4();
    const startTime = Date.now();
    console.log(`Received job ingestion request: ${requestId}, Body: ${event.body}`);

    if (!agentRegistryTableName || !webSocketApiEndpoint || !orchestratorQueueUrl) {
        console.error('Missing required environment variables: AGENT_REGISTRY_TABLE_NAME, WEBSOCKET_API_ENDPOINT or ORCHESTRATOR_QUEUE_URL');
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

        // Check for sync parameter
        const isSync = jobRequest.sync === true || event.queryStringParameters?.sync === 'true';
        console.log(`Request ${requestId} - Synchronous mode: ${isSync}`);

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

        const effectiveTimeoutMs = timeoutMs || 30000;

        // --- Create JobData object ---
        const newJob: JobData = {
            jobId,
            url: jobRequest.url,
            method: jobRequest.method.toUpperCase(),
            headers: jobRequest.headers || {},
            body: jobRequest.body, // Agent expects string (potentially base64)
            status: 'pending',
            createdAt: new Date().toISOString(),
            timeoutMs: effectiveTimeoutMs,
        };

        if (isSync) {
            // --- Synchronous Flow --- 
            const correlationId = uuidv4();
            const queueName = `job-response-${correlationId}.fifo`; // Use FIFO for potential future ordering needs
            let queueUrl: string | undefined;
            const lambdaTimeout = context.getRemainingTimeInMillis() - SYNC_TIMEOUT_BUFFER_MS;
            const maxWaitTime = Math.min(MAX_SYNC_WAIT_MS, lambdaTimeout, effectiveTimeoutMs + 1000); // Use job timeout + buffer, capped by lambda/overall limit
            console.log(`Request ${requestId} (Sync): Max wait time calculated: ${maxWaitTime}ms (Lambda: ${lambdaTimeout}ms, Job: ${effectiveTimeoutMs}ms)`);

            try {
                // 1. Create temporary response queue
                console.log(`Request ${requestId} (Sync): Creating temporary queue ${queueName}`);
                const createQueueCommand = new CreateQueueCommand({
                    QueueName: queueName,
                    Attributes: {
                        FifoQueue: 'true', // FIFO attribute
                        ContentBasedDeduplication: 'true', // Simplifies message sending
                        MessageRetentionPeriod: TEMP_QUEUE_RETENTION_SECONDS,
                        // Add DLQ later if needed
                    },
                    tags: {
                        jobId: jobId,
                        correlationId: correlationId,
                        createdBy: 'job-ingestion-lambda'
                    }
                });
                const createQueueResponse = await sqsClient.send(createQueueCommand);
                queueUrl = createQueueResponse.QueueUrl;
                if (!queueUrl) {
                    throw new Error('Failed to create temporary response queue.');
                }
                console.log(`Request ${requestId} (Sync): Created queue ${queueUrl}`);

                // 2. Dispatch job to Orchestrator via SQS
                console.log(`Request ${requestId} (Sync): Sending job ${jobId} to orchestrator queue ${orchestratorQueueUrl}`);
                const dispatchPayload = { ...newJob, correlationId, responseQueueUrl: queueUrl };
                
                // Send message to Orchestrator Input Queue
                await sqsClient.send(new SendMessageCommand({ 
                    QueueUrl: orchestratorQueueUrl, 
                    MessageBody: JSON.stringify(dispatchPayload),
                    MessageGroupId: jobId, // Use Job ID for FIFO grouping
                    // MessageDeduplicationId: correlationId // Optional with ContentBasedDeduplication
                }));
                 
                 console.log(`Request ${requestId} (Sync): Job ${jobId} sent to orchestrator queue.`);

                // 3. Wait for response from the temporary queue
                console.log(`Request ${requestId} (Sync): Waiting for response on ${queueUrl} (max ${maxWaitTime}ms)...`);
                let responseMessage;
                const waitStartTime = Date.now();
                while (Date.now() - waitStartTime < maxWaitTime) {
                    const remainingTime = maxWaitTime - (Date.now() - waitStartTime);
                    if (remainingTime <= 0) break;
                    const waitTimeSeconds = Math.min(SQS_WAIT_TIME_SECONDS, Math.ceil(remainingTime / 1000));
                    if (waitTimeSeconds <= 0) break; 
                    
                    console.log(`Request ${requestId} (Sync): Polling queue ${queueUrl} (wait: ${waitTimeSeconds}s)...`);
                    const receiveMessageCommand = new ReceiveMessageCommand({
                        QueueUrl: queueUrl,
                        MaxNumberOfMessages: 1,
                        WaitTimeSeconds: waitTimeSeconds,
                        AttributeNames: ['All'], // Get all attributes
                        MessageAttributeNames: ['All'] // Get all message attributes
                    });

                    const receiveMessageResponse = await sqsClient.send(receiveMessageCommand);

                    if (receiveMessageResponse.Messages && receiveMessageResponse.Messages.length > 0) {
                        responseMessage = receiveMessageResponse.Messages[0];
                        console.log(`Request ${requestId} (Sync): Received response message ${responseMessage.MessageId}`);
                        
                        // Delete the received message
                        await sqsClient.send(new DeleteMessageCommand({
                            QueueUrl: queueUrl,
                            ReceiptHandle: responseMessage.ReceiptHandle!,
                        }));
                        console.log(`Request ${requestId} (Sync): Deleted message ${responseMessage.MessageId} from queue.`);
                        break; // Exit loop on message received
                    }
                }

                // 4. Process response or handle timeout
                if (responseMessage && responseMessage.Body) {
                    console.log(`Request ${requestId} (Sync): Processing final response.`);
                    const jobResult = JSON.parse(responseMessage.Body); 
                    // TODO: More robust parsing/validation of jobResult

                    // Clean up the temporary queue immediately after getting the response
                    await deleteTempQueue(queueUrl, requestId, '(sync response received)');

                    // Check if the response indicates failure
                    if (jobResult.status === 'failure' || jobResult.error) {
                        console.warn(`[${jobId}] Received failure response from orchestrator/agent:`, jobResult.error);
                        const agentError = jobResult.error || {};
                        // Determine appropriate status code to return to client
                        let clientStatusCode = 502; // Bad Gateway by default for downstream errors
                        if (agentError.statusCode && agentError.statusCode >= 400 && agentError.statusCode < 500) {
                             // Optionally pass through 4xx errors from the target if desired
                             // clientStatusCode = agentError.statusCode;
                        } else if (agentError.code === 'AGENT_TIMEOUT') {
                            clientStatusCode = 504; // Gateway Timeout if agent specifically timed out
                        }

                        return {
                            statusCode: clientStatusCode,
                            body: JSON.stringify({
                                message: `Job failed during execution: ${agentError.message || 'Unknown agent error'}`,
                                agentErrorCode: agentError.code || 'UNKNOWN',
                                agentErrorDetails: agentError.details,
                                jobId: jobId,
                                requestId: requestId
                            }),
                            headers: { 'Content-Type': 'application/json' },
                        };
                    } else {
                        // Success path
                        const finalHeaders = { ...(jobResult.headers || { 'Content-Type': 'application/json' }) }; // Start with original headers or default
                        const responsePayload = jobResult.payload || {}; // Get the payload containing body, status, etc.

                        if (responsePayload.isBase64Encoded) {
                             finalHeaders['X-Body-Encoding'] = 'base64';
                        }

                        return {
                            statusCode: responsePayload.statusCode || jobResult.statusCode || 200, // Prioritize status from payload
                            // Return the agent's payload structure directly within the result field
                            body: JSON.stringify({ 
                                message: 'Job completed successfully.',
                                jobId: jobId,
                                requestId: requestId,
                                result: responsePayload // Contains statusCode, headers, body, isBase64Encoded
                            }), 
                            headers: finalHeaders,
                        };
                    }
                } else {
                    console.warn(`Request ${requestId} (Sync): Timed out waiting for response after ${Date.now() - waitStartTime}ms.`);
                    // Clean up the queue on timeout
                    await deleteTempQueue(queueUrl, requestId, '(sync timeout)');
                    return {
                        statusCode: 504, // Gateway Timeout
                        body: JSON.stringify({ 
                            message: 'Request timed out waiting for job completion.',
                            jobId: jobId,
                            requestId: requestId 
                        }),
                    };
                }

            } catch (syncError: any) {
                console.error(`Request ${requestId} (Sync): Error during synchronous flow for job ${jobId}:`, syncError);
                // Attempt to clean up the queue even if an error occurred
                if (queueUrl) {
                    await deleteTempQueue(queueUrl, requestId, '(sync error cleanup)');
                }
                return {
                    statusCode: 500,
                    body: JSON.stringify({ message: 'Error during synchronous job processing.', error: syncError.message, jobId, requestId }),
                };
            }

        } else {
            // --- Asynchronous Flow (Existing Logic) ---
            console.log(`Request ${requestId} (Async): Sending job ${jobId} to orchestrator queue ${orchestratorQueueUrl}...`);
             
             // Send message to Orchestrator Input Queue (without response info)
             await sqsClient.send(new SendMessageCommand({ 
                QueueUrl: orchestratorQueueUrl, 
                MessageBody: JSON.stringify(newJob), 
                MessageGroupId: jobId, // Use Job ID for FIFO grouping
             }));

            console.log(`Request ${requestId} (Async): Job ${jobId} accepted and sent to queue.`);
            return {
                statusCode: 202, // Accepted
                body: JSON.stringify({
                    message: 'Job accepted and sent to orchestrator queue.', // Updated message
                    jobId: jobId,
                    requestId: requestId,
                }),
            };
        }

    } catch (error: any) {
        console.error(`Error processing job ingestion request ${requestId}:`, error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Failed to process job request.', error: error.message, requestId }),
        };
    }
}; 

// Helper function to delete the temporary SQS queue
async function deleteTempQueue(queueUrl: string, requestId: string, context: string) {
    try {
        console.log(`Request ${requestId} ${context}: Deleting temporary queue ${queueUrl}`);
        await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        console.log(`Request ${requestId} ${context}: Successfully deleted queue ${queueUrl}`);
    } catch (deleteError: any) {
        // Log error but don't fail the main flow, queue will expire anyway
        console.error(`Request ${requestId} ${context}: Failed to delete temporary queue ${queueUrl}:`, deleteError);
    }
} 