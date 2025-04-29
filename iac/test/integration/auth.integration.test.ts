import WebSocket from 'ws';
import * as AWS from 'aws-sdk';
import fetch from 'node-fetch';

// Configure AWS SDK (ensure credentials are configured in the environment)
AWS.config.update({ region: process.env.AWS_REGION || 'us-west-2' }); // Use your stack's region
const cloudWatchLogs = new AWS.CloudWatchLogs();

const WEBSOCKET_API_URL = process.env.WEBSOCKET_API_URL;
const HTTP_API_URL = process.env.HTTP_API_URL; // Needed for /metrics
const CONNECT_HANDLER_LOG_GROUP = process.env.CONNECT_HANDLER_LOG_GROUP_NAME; // e.g., /aws/lambda/OrchestratorStack-ConnectHandler-XYZ

if (!WEBSOCKET_API_URL || !HTTP_API_URL || !CONNECT_HANDLER_LOG_GROUP) {
  throw new Error('Missing required environment variables: WEBSOCKET_API_URL, HTTP_API_URL, CONNECT_HANDLER_LOG_GROUP_NAME');
}

// Helper function to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to fetch metrics and parse
async function getMetrics(): Promise<Map<string, number>> {
  const metricsMap = new Map<string, number>();
  try {
    const response = await fetch(`${HTTP_API_URL}/metrics`);
    if (!response.ok) {
      console.warn(`Failed to fetch metrics: ${response.statusText}`);
      return metricsMap;
    }
    const text = await response.text();
    const lines = text.split('\n');
    lines.forEach(line => {
      if (line.startsWith('#') || line.trim() === '') return; // Skip comments and empty lines
      const parts = line.split(' ');
      const metricKey = parts[0];
      const metricValue = parseFloat(parts[1]);
      if (!isNaN(metricValue)) {
        metricsMap.set(metricKey, metricValue);
      }
    });
  } catch (error) {
    console.warn('Error fetching or parsing metrics:', error);
  }
  return metricsMap;
}

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

describe('Authentication Integration Tests', () => {
  it('should fail connection with invalid API key and log ORH-1001', async () => {
    const connectStartTime = Date.now() - 5000; // Look back 5 seconds for logs/metrics
    let connectionClosed = false;
    let connectionError: Error | null = null;

    // --- Get initial metric value ---    
    const initialMetrics = await getMetrics();
    const initialErrorCount = initialMetrics.get('lambda_invocations_total{function_name="ConnectHandler",status="error"}') || 0;

    // --- Attempt WebSocket connection ---    
    const ws = new WebSocket(`${WEBSOCKET_API_URL}?agentKey=INVALID_KEY`);

    const closePromise = new Promise<void>((resolve) => {
      ws.on('close', (code: number, reason: Buffer) => {
        console.log(`WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
        connectionClosed = true;
        resolve();
      });

      ws.on('error', (error: Error) => {
        console.error('WebSocket error:', error.message);
        connectionError = error;
        // Close might not fire after error, so resolve here too
        if (!connectionClosed) {
             connectionClosed = true;
             resolve(); 
        }
      });

      ws.on('open', () => {
        console.warn('WebSocket unexpectedly opened with invalid key!');
        ws.close(); // Close it immediately if it opens
        resolve(); // Resolve promise on open if it shouldn't have
      });
    });

    await closePromise; // Wait for connection to close or error

    // --- Assertions ---    
    expect(connectionClosed).toBe(true); // Connection should have closed or errored
    // We expect an error or a close event, possibly with a specific code, 
    // but exact behavior might vary. The core check is that it didn't stay open.

    // --- Verify Logs and Metrics (with polling) ---    
    let logFound = false;
    let metricIncremented = false;
    const maxAttempts = 10;
    const pollDelay = 5000; // 5 seconds

    console.log('Polling CloudWatch Logs and /metrics for verification...');
    for (let i = 0; i < maxAttempts; i++) {
      console.log(`Attempt ${i + 1}/${maxAttempts}...`);

      // Check Logs
      if (!logFound) {
        logFound = await checkLogsForPattern(CONNECT_HANDLER_LOG_GROUP, '{ $.level = "ERROR" && $.context.errorCode = "ORH-1001" }', connectStartTime);
        if (logFound) console.log('ORH-1001 log found!');
      }

      // Check Metrics
      if (!metricIncremented) {
        const currentMetrics = await getMetrics();
        const currentErrorCount = currentMetrics.get('lambda_invocations_total{function_name="ConnectHandler",status="error"}') || 0;
        if (currentErrorCount > initialErrorCount) {
            metricIncremented = true;
            console.log('ConnectHandler error metric incremented!');
        } else {
            console.log(`Current error count (${currentErrorCount}) not greater than initial (${initialErrorCount})`);
        }
      }

      if (logFound && metricIncremented) {
        break; // Exit loop if both conditions are met
      }

      if (i < maxAttempts - 1) {
          await delay(pollDelay); // Wait before next poll
      }
    }

    expect(logFound).toBe(true); // Assert log was found after polling
    expect(metricIncremented).toBe(true); // Assert metric incremented after polling

  }, 70000); // Increase timeout for this specific test to allow polling
}); 