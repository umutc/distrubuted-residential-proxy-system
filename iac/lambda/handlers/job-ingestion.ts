import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { JobData } from '../utils/types';
import { dispatchJob } from '../utils/job-dispatcher';
import { SQSClient, CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, DeleteMessageCommand, GetQueueAttributesCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import logger from '../utils/logger'; // Import the shared logger
import { CloudWatchClient, PutMetricDataCommand, MetricDatum } from '@aws-sdk/client-cloudwatch';
// import { DynamoDBClient } from '@aws-sdk/client-dynamodb'; // For Job Repository

// const jobRepositoryTableName = process.env.JOB_REPOSITORY_TABLE_NAME;
const agentRegistryTableName = process.env.AGENT_REGISTRY_TABLE_NAME;
const webSocketApiEndpoint = process.env.WEBSOCKET_API_ENDPOINT;
const orchestratorQueueUrl = process.env.ORCHESTRATOR_QUEUE_URL; // Add this env var

const sqsClient = new SQSClient({});
const cloudwatchClient = new CloudWatchClient({}); // Initialize CloudWatch client
const METRIC_NAMESPACE = 'DistributedResidentialProxy'; // Define a namespace for metrics

// Constants for synchronous flow
const SYNC_TIMEOUT_BUFFER_MS = 2000; // Buffer before Lambda timeout
const SQS_WAIT_TIME_SECONDS = 20; // Max SQS long polling wait time
const MAX_SYNC_WAIT_MS = 28000; // Max time to wait for sync response (slightly less than 29s API GW limit)
const TEMP_QUEUE_RETENTION_SECONDS = '60'; // Keep queue for 1 min just in case

export const handler = async (event: APIGatewayProxyEventV2, context: Context): Promise<APIGatewayProxyResultV2> => {
    const requestId = uuidv4();
    const startTime = Date.now();
    const log = logger.child({ handlerRequestId: requestId });
    log.info({ path: event.rawPath, queryString: event.rawQueryString, bodyLength: event.body?.length }, `Received job ingestion request`);

    if (!agentRegistryTableName || !webSocketApiEndpoint || !orchestratorQueueUrl) {
        log.error({ 
            errorCode: 'ORC-CFG-1001',
            agentRegistryTableSet: !!agentRegistryTableName,
            websocketEndpointSet: !!webSocketApiEndpoint,
            orchestratorQueueSet: !!orchestratorQueueUrl 
        }, 'Missing required environment variables');
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Internal server configuration error.', requestId }),
        };
    }

    // Basic validation
    if (!event.body) {
        log.warn({ errorCode: 'ORC-VAL-1002' }, 'Missing request body');
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
            log.warn({ urlReceived: url, errorCode: 'ORC-VAL-1002' }, 'Invalid request: Missing or invalid url');
            return { statusCode: 400, body: JSON.stringify({ message: 'Invalid request: Missing or invalid url', requestId: requestId }) };
        }
        // Basic URL validation
        try {
            new URL(url);
        } catch (e) {
            log.warn({ urlReceived: url, errorCode: 'ORC-VAL-1002' }, 'Invalid request: Malformed URL');
            return { statusCode: 400, body: JSON.stringify({ message: 'Invalid request: Malformed URL', requestId: requestId }) };
        }

        if (!method || typeof method !== 'string' || !['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
            log.warn({ methodReceived: method, errorCode: 'ORC-VAL-1002' }, `Invalid request: Missing or invalid method`);
            return { statusCode: 400, body: JSON.stringify({ message: `Invalid request: Missing or invalid method: ${method}`, requestId: requestId }) };
        }

        if (headers && typeof headers !== 'object') {
            log.warn({ headersType: typeof headers, errorCode: 'ORC-VAL-1002' }, 'Invalid request: headers must be an object');
            return { statusCode: 400, body: JSON.stringify({ message: 'Invalid request: headers must be an object', requestId: requestId }) };
        }

        if (body && typeof body !== 'string') {
            log.warn({ bodyType: typeof body, errorCode: 'ORC-VAL-1002' }, 'Invalid request: body must be a string');
            return { statusCode: 400, body: JSON.stringify({ message: 'Invalid request: body must be a string (potentially Base64 encoded)', requestId: requestId }) };
        }

        if (bodyEncoding && !['base64', 'utf8'].includes(bodyEncoding)) {
            log.warn({ bodyEncodingReceived: bodyEncoding, errorCode: 'ORC-VAL-1002' }, `Invalid request: invalid bodyEncoding`);
            return { statusCode: 400, body: JSON.stringify({ message: `Invalid request: invalid bodyEncoding: ${bodyEncoding}. Must be 'base64' or 'utf8'.`, requestId: requestId }) };
        }

        if (timeoutMs && (typeof timeoutMs !== 'number' || timeoutMs <= 0)) {
            log.warn({ timeoutMsReceived: timeoutMs, errorCode: 'ORC-VAL-1002' }, 'Invalid request: timeoutMs must be a positive number');
            return { statusCode: 400, body: JSON.stringify({ message: 'Invalid request: timeoutMs must be a positive number', requestId: requestId }) };
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
            log.info({ jobId, correlationId, queueUrl, maxWaitTimeMs: maxWaitTime }, `Starting wait loop for synchronous response.`); // Added detailed log

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
                log.debug({ queueUrl, maxWaitTimeMs: maxWaitTime }, `Entering SQS receive message loop.`); // Changed console.log to log.debug
                let responseMessage;
                const waitStartTime = Date.now();
                while (Date.now() - waitStartTime < maxWaitTime) {
                    const loopIterationStartTime = Date.now(); // Track loop iteration start
                    const remainingTimeOverall = maxWaitTime - (Date.now() - waitStartTime);
                    const remainingLambdaTime = context.getRemainingTimeInMillis();

                    // Calculate SQS wait time, ensuring it doesn't exceed remaining overall time or lambda time budget
                    const sqsWaitPotential = Math.min(
                        SQS_WAIT_TIME_SECONDS, 
                        Math.floor(remainingTimeOverall / 1000),
                        Math.floor((remainingLambdaTime - SYNC_TIMEOUT_BUFFER_MS) / 1000) // Check against remaining Lambda time with buffer
                    );
                    
                    if (sqsWaitPotential <= 0) {
                       log.warn({ jobId, correlationId, remainingTimeOverall, remainingLambdaTime }, `Insufficient time remaining for SQS polling. Breaking wait loop.`);
                       break; // Exit loop if not enough time to poll and cleanup
                    }
                    const waitTimeSeconds = sqsWaitPotential;
                    
                    log.debug({ jobId, correlationId, queueUrl, waitTimeSeconds, remainingTimeOverall, remainingLambdaTime }, `Polling queue...`); // Changed console.log to log.debug

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

                // Check if loop exited due to timeout
                if (!responseMessage) {
                   log.warn({ jobId, correlationId, waitedMs: Date.now() - waitStartTime, maxWaitTimeMs: maxWaitTime }, `Wait loop finished without receiving a message (timeout or insufficient time).`);
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
            } finally {
                // Ensure queueUrl is defined before attempting deletion
                if (queueUrl) {
                    log.info({ jobId, correlationId, queueUrl }, `Initiating cleanup of temporary queue.`);
                    await deleteTempQueue(queueUrl, requestId, '(sync flow completion)');
                } else {
                    log.warn({ jobId, correlationId }, `Cannot cleanup temporary queue as queueUrl was not defined (likely queue creation failed).`);
                }
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
        // --- Handling Unhandled Errors ---
        // Try to get jobId even in the error case for better logging/metrics
        let jobIdForErrorLogging = 'unknown';
        try {
            // Attempt to parse jobId from body if possible, even if validation failed earlier
            const potentialBody = JSON.parse(event.body || '{}');
            if (potentialBody && typeof potentialBody.jobId === 'string') {
                jobIdForErrorLogging = potentialBody.jobId;
            }
            // Add other potential locations if needed
        } catch {
            // Ignore parsing errors, stick with 'unknown'
        }

        // Use the main logger instance here, as jobLog might not be defined if error occurred before its creation
        logger.error({ error: error.message, stack: error.stack, jobIdAttempted: jobIdForErrorLogging }, 'Unhandled error during job ingestion');

        // Try to publish an error metric, but don't let it block the response
        publishMetrics(jobIdForErrorLogging, 'error', Date.now() - startTime).catch(metricError => {
             logger.error({ metricError: metricError.message }, 'Failed to publish error metric');
        });

        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Failed to process job request.', error: error.message, requestId }),
        };
    }
}; 

// Helper function to delete the temporary SQS queue
async function deleteTempQueue(queueUrl: string, requestId: string, context: string) {
    if (!queueUrl) return;
    const log = logger.child({ handlerRequestId: requestId, queueUrl, deleteContext: context }); // Use provided request ID
    log.info(`Attempting to delete temporary queue`);
    try {
        await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        log.info(`Successfully deleted temporary queue.`);
    } catch (deleteError: any) {
        // Use specific error code
        log.error({ errorCode: 'ORC-DEP-1007', error: deleteError.message, stack: deleteError.stack }, `Failed to delete temporary queue`);
    }
} 

async function processSynchronously(jobPayload: any, timeoutSeconds: number): Promise<any> {
  const correlationId = uuidv4();
  const tempQueueName = `job-response-${correlationId}.fifo`;
  let responseQueueUrl: string | undefined;
  const startTime = Date.now(); // Record start time
  let status = 'failure'; // Default status
  let result: any;

  try {
    // Create temporary response queue
    const createQueueResponse = await sqsClient.send(new CreateQueueCommand({
      QueueName: tempQueueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'true',
        MessageRetentionPeriod: '300' // 5 minutes
      },
      tags: { 
        TemporaryQueue: 'true',
        JobId: jobPayload.jobId
      }
    }));
    
    responseQueueUrl = createQueueResponse.QueueUrl;
    if (!responseQueueUrl) {
      throw new Error('Failed to create temporary response queue');
    }
    
    // Send job to orchestrator with response queue info
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: orchestratorQueueUrl,
      MessageBody: JSON.stringify({
        ...jobPayload,
        responseQueueUrl,
        correlationId
      }),
      MessageGroupId: correlationId,
      MessageDeduplicationId: correlationId
    }));
    
    logger.debug(`Waiting for response on queue ${responseQueueUrl} for job ${jobPayload.jobId}`);

    // Wait for response
    while (Date.now() - startTime < timeoutSeconds * 1000) {
      const receiveResponse = await sqsClient.send(new ReceiveMessageCommand({
        QueueUrl: responseQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: Math.min(5, timeoutSeconds - Math.ceil((Date.now() - startTime)/1000)) // Adjust wait time dynamically
      }));
      
      if (receiveResponse.Messages && receiveResponse.Messages.length > 0) {
        const message = receiveResponse.Messages[0];
        logger.debug(`Received response message ${message.MessageId} for job ${jobPayload.jobId}`);
        
        // Delete message from queue
        await sqsClient.send(new DeleteMessageCommand({
          QueueUrl: responseQueueUrl,
          ReceiptHandle: message.ReceiptHandle!
        }));
        
        // Parse and return result
        result = JSON.parse(message.Body || '{}');
        // Determine status from the response payload if possible, otherwise assume success
        status = result?.status || 'success'; 
        logger.info(`Synchronous job ${jobPayload.jobId} completed with status: ${status}`);
        return result; // Exit loop and function on success
      }
    }
    
    // If loop finishes without returning, it's a timeout
    status = 'timeout';
    logger.warn(`Synchronous job ${jobPayload.jobId} timed out after ${timeoutSeconds} seconds.`);
    throw new Error(`Job processing timed out after ${timeoutSeconds} seconds`);

  } catch(error) {
      // status remains 'failure' unless overridden by timeout
      logger.error(`Error during synchronous processing for job ${jobPayload.jobId}:`, error);
      throw error; // Re-throw the error to be caught by the main handler
  } finally {
      const durationMs = Date.now() - startTime;
      logger.debug(`Synchronous job ${jobPayload.jobId} finished processing. Status: ${status}, Duration: ${durationMs}ms`);
      // Publish metrics regardless of success/failure/timeout
      await publishMetrics(jobPayload.jobId, status, durationMs);

      // Clean up temporary queue if it was created
      if (responseQueueUrl) {
          try {
              await sqsClient.send(new DeleteQueueCommand({
                  QueueUrl: responseQueueUrl
              }));
              logger.debug('Temporary response queue deleted', { queueUrl: responseQueueUrl });
          } catch (error) {
              logger.warn('Failed to delete temporary queue', { queueUrl: responseQueueUrl, error });
          }
      }
  }
}

async function publishMetrics(jobId: string, status: string, durationMs: number): Promise<void> {
    const log = logger.child({ jobId, metricStatus: status, durationMs });
    log.info('Publishing metrics to CloudWatch');
    try {
        const timestamp = new Date();
        // Use MetricDatum type from @aws-sdk/client-cloudwatch
        const metricData: MetricDatum[] = [
            {
                MetricName: 'SynchronousJobResult',
                Dimensions: [
                    { Name: 'Status', Value: status },
                    // Add other relevant dimensions like JobType if available
                    // { Name: 'JobType', Value: jobPayload.jobType || 'Unknown' }
                ],
                Timestamp: timestamp,
                Value: 1,
                Unit: 'Count'
            },
            {
                MetricName: 'SynchronousJobDuration',
                Dimensions: [
                     { Name: 'Status', Value: status }, // Optional: Dimension duration by status
                ],
                Timestamp: timestamp,
                Value: durationMs,
                Unit: 'Milliseconds'
            }
        ];

        await cloudwatchClient.send(new PutMetricDataCommand({
            Namespace: METRIC_NAMESPACE,
            MetricData: metricData
        }));
        log.debug('Successfully published CloudWatch metrics');
    } catch (error: any) {
        log.warn({ errorCode: 'ORC-DEP-1000' /* Generic AWS */, error: error.message, stack: error.stack }, 'Failed to publish CloudWatch metrics');
        // Don't fail the whole request if metrics fail
    }
} 