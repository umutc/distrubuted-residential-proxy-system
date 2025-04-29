import * as AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';

// Configure AWS SDK
AWS.config.update({ region: process.env.AWS_REGION || 'us-west-2' });
const sqs = new AWS.SQS();
const cloudWatchLogs = new AWS.CloudWatchLogs();
const dynamoDb = new AWS.DynamoDB.DocumentClient();

// Environment Variables (ensure these are set for the test execution)
const ORCHESTRATOR_INPUT_QUEUE_URL = process.env.ORCHESTRATOR_INPUT_QUEUE_URL;
const DISPATCHER_HANDLER_LOG_GROUP = process.env.DISPATCHER_HANDLER_LOG_GROUP_NAME;
const AGENT_REGISTRY_TABLE_NAME = process.env.AGENT_REGISTRY_TABLE_NAME || 'distributed-res-proxy-agent-registry';

if (!ORCHESTRATOR_INPUT_QUEUE_URL || !DISPATCHER_HANDLER_LOG_GROUP) {
  throw new Error('Missing required environment variables: ORCHESTRATOR_INPUT_QUEUE_URL, DISPATCHER_HANDLER_LOG_GROUP_NAME');
}

// Helper function to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to check CloudWatch logs for a specific pattern
async function checkLogsForPattern(logGroupName: string, pattern: string, startTime: number): Promise<boolean> {
  try {
    const params: AWS.CloudWatchLogs.FilterLogEventsRequest = {
      logGroupName: logGroupName,
      startTime: startTime,
      filterPattern: pattern,
    };
    const data = await cloudWatchLogs.filterLogEvents(params).promise();
    return (data.events?.length ?? 0) > 0;
  } catch (error) {
    console.error('Error checking CloudWatch Logs:', error);
    return false;
  }
}

// Helper to ensure no agents are available (or mark them busy)
async function ensureNoAvailableAgents() {
  try {
    // A simple approach: Scan and update any 'available' agents to 'busy'
    // Note: This might not be perfectly race-condition proof in a highly active system
    // but should be sufficient for isolated testing.
    const scanParams: AWS.DynamoDB.DocumentClient.ScanInput = {
      TableName: AGENT_REGISTRY_TABLE_NAME,
      FilterExpression: '#st = :statusVal',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':statusVal': 'available' },
      ProjectionExpression: 'connectionId'
    };

    let availableAgents = await dynamoDb.scan(scanParams).promise();

    for (const agent of availableAgents.Items || []) {
      console.log(`Setting agent ${agent.connectionId} to busy for test setup...`);
      const updateParams: AWS.DynamoDB.DocumentClient.UpdateItemInput = {
        TableName: AGENT_REGISTRY_TABLE_NAME,
        Key: { connectionId: agent.connectionId },
        UpdateExpression: 'set #st = :newStatus',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':newStatus': 'busy' }
      };
      await dynamoDb.update(updateParams).promise();
    }
    console.log('Ensured no agents are marked as available.');

  } catch (error) {
    console.error('Error ensuring no available agents:', error);
    throw error; // Re-throw to fail the test setup if necessary
  }
}

describe('Dispatcher Integration Tests', () => {

  beforeAll(async () => {
    // Ensure the state is clean before tests
    await ensureNoAvailableAgents();
  });

  it('should log ORH-1003 when no agents are available for a job', async () => {
    const testStartTime = Date.now() - 5000; // Look back slightly for logs
    const jobId = uuidv4();
    const jobPayload = {
      jobId: jobId,
      payload: { url: 'https://example.com', method: 'GET' },
      timestamp: new Date().toISOString()
    };

    // --- Ensure no agents are available (redundant due to beforeAll, but safe) ---
    await ensureNoAvailableAgents();

    // --- Send Job to Input Queue ---    
    console.log(`Sending job ${jobId} to queue ${ORCHESTRATOR_INPUT_QUEUE_URL}`);
    try {
      await sqs.sendMessage({
        QueueUrl: ORCHESTRATOR_INPUT_QUEUE_URL,
        MessageBody: JSON.stringify(jobPayload),
        MessageGroupId: jobId, // Required for FIFO queues
        MessageDeduplicationId: uuidv4() // Ensure unique message
      }).promise();
      console.log(`Job ${jobId} sent successfully.`);
    } catch (error) {
      console.error('Failed to send job to SQS:', error);
      throw error; // Fail test if sending fails
    }

    // --- Verify Logs (with polling) ---    
    let logFound = false;
    const maxAttempts = 12; // Allow up to a minute for SQS processing + logging
    const pollDelay = 5000; // 5 seconds

    console.log('Polling Dispatcher logs for ORH-1003...');
    for (let i = 0; i < maxAttempts; i++) {
      console.log(`Attempt ${i + 1}/${maxAttempts}...`);

      logFound = await checkLogsForPattern(DISPATCHER_HANDLER_LOG_GROUP, '{ $.level = "WARN" && $.context.errorCode = "ORH-1003" && $.context.jobId = "' + jobId + '" }', testStartTime);
      
      if (logFound) {
        console.log('ORH-1003 log found for job!');
        break; // Exit loop if condition is met
      }

      if (i < maxAttempts - 1) {
        await delay(pollDelay); // Wait before next poll
      }
    }

    // --- Assertions ---    
    expect(logFound).toBe(true); // Assert log was found after polling

    // Optional: Verify SQS message is still in queue or moved to DLQ (more complex)
    // Optional: Verify agents_available_current metric is 0 (requires metric fetching setup)

  }, 70000); // Increase timeout for SQS processing and polling

}); 