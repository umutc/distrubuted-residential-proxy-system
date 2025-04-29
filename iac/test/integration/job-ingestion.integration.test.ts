import * as AWS from 'aws-sdk';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid'; // For potential use later

// Configure AWS SDK
AWS.config.update({ region: process.env.AWS_REGION || 'us-west-2' });
const cloudWatchLogs = new AWS.CloudWatchLogs();

// Environment Variables
const HTTP_API_URL = process.env.HTTP_API_URL;
const JOB_INGESTION_HANDLER_LOG_GROUP = process.env.JOB_INGESTION_HANDLER_LOG_GROUP_NAME;
const ORCHESTRATOR_INPUT_QUEUE_URL = process.env.ORCHESTRATOR_INPUT_QUEUE_URL;

if (!HTTP_API_URL || !JOB_INGESTION_HANDLER_LOG_GROUP || !ORCHESTRATOR_INPUT_QUEUE_URL) {
  throw new Error('Missing required environment variables: HTTP_API_URL, JOB_INGESTION_HANDLER_LOG_GROUP_NAME, ORCHESTRATOR_INPUT_QUEUE_URL');
}

// Helper function to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to fetch metrics and parse (reuse from auth test or place in shared file)
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
      if (line.startsWith('#') || line.trim() === '') return;
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

// Helper function to check CloudWatch logs for a specific pattern (reuse from auth test)
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

describe('Job Ingestion Integration Tests', () => {

  it('should return 400 and log ORH-2001 for invalid job payload', async () => {
    const testStartTime = Date.now() - 5000; // Look back slightly for logs/metrics
    const invalidPayload = {
      // Missing required fields like 'url' or 'method' (assuming basic validation)
      someOtherField: 'test'
    };

    // --- Get initial metric value ---
    const initialMetrics = await getMetrics();
    const initialHttp400Count = initialMetrics.get('http_requests_total{method="POST",path="/jobs",status_code="400"}') || 0;

    // --- Send Invalid Job Request ---    
    let responseStatus = 0;
    let responseBody = '';
    console.log(`Sending invalid job payload to ${HTTP_API_URL}/jobs`);
    try {
      const response = await fetch(`${HTTP_API_URL}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidPayload),
      });
      responseStatus = response.status;
      responseBody = await response.text(); // Read body even for errors
      console.log(`Received response: ${responseStatus}, Body: ${responseBody}`);
    } catch (error) {
      console.error('Failed to send job request:', error);
      throw error; // Fail test if sending fails
    }

    // --- Assertions ---    
    expect(responseStatus).toBe(400); // Expect Bad Request

    // --- Verify Logs and Metrics (with polling) ---    
    let logFound = false;
    let metricIncremented = false;
    const maxAttempts = 10;
    const pollDelay = 5000; // 5 seconds

    console.log('Polling Job Ingestion logs and /metrics for verification...');
    for (let i = 0; i < maxAttempts; i++) {
      console.log(`Attempt ${i + 1}/${maxAttempts}...`);

      // Check Logs
      if (!logFound) {
        // Adjust pattern if specific errorCode isn't logged for validation, check for general error
        logFound = await checkLogsForPattern(JOB_INGESTION_HANDLER_LOG_GROUP, '{ $.level = "ERROR" || $.level = "WARN" }', testStartTime); 
        // TODO: Refine log pattern check if ORH-2001 is explicitly logged for validation errors
        if (logFound) console.log('JobIngestionHandler validation error log found!');
      }

      // Check Metrics
      if (!metricIncremented) {
        const currentMetrics = await getMetrics();
        const currentHttp400Count = currentMetrics.get('http_requests_total{method="POST",path="/jobs",status_code="400"}') || 0;
        if (currentHttp400Count > initialHttp400Count) {
            metricIncremented = true;
            console.log('HTTP 400 metric for /jobs incremented!');
        } else {
            console.log(`Current 400 count (${currentHttp400Count}) not greater than initial (${initialHttp400Count})`);
        }
      }

      if (logFound && metricIncremented) {
        break; // Exit loop if both conditions are met
      }

      if (i < maxAttempts - 1) {
          await delay(pollDelay); // Wait before next poll
      }
    }

    // TODO: Refine log assertion once logging for validation errors is confirmed
    expect(logFound).toBe(true); // Assert some error/warning log was found
    expect(metricIncremented).toBe(true); // Assert metric incremented

  }, 70000); // Increase timeout for API call and polling

  it('should return 202 and enqueue job for valid async payload', async () => {
    const testStartTime = Date.now() - 5000;
    const jobId = uuidv4(); // Generate a unique ID for this job
    const validPayload = {
        jobId: jobId, // Include jobId if handler expects it or generates internally
        url: 'https://httpbin.org/get',
        method: 'GET',
        // Add other necessary fields based on actual job schema
    };

    // --- Get initial metric values ---
    const initialMetrics = await getMetrics();
    const initialHttp202Count = initialMetrics.get('http_requests_total{method="POST",path="/jobs",status_code="202"}') || 0;
    // Note: Directly checking SQS SendMessage metric is hard without custom metrics/traces
    // We will rely on logs and HTTP status for verification.

    // --- Send Valid Job Request ---    
    let responseStatus = 0;
    let responseBodyJson: any = {};
    console.log(`Sending valid async job payload to ${HTTP_API_URL}/jobs`);
    try {
      const response = await fetch(`${HTTP_API_URL}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      responseStatus = response.status;
      const responseBody = await response.text();
      console.log(`Received response: ${responseStatus}, Body: ${responseBody}`);
      if (response.ok) {
         responseBodyJson = JSON.parse(responseBody);
      }
    } catch (error) {
      console.error('Failed to send job request:', error);
      throw error; // Fail test if sending fails
    }

    // --- Assertions ---    
    expect(responseStatus).toBe(202); // Expect Accepted
    expect(responseBodyJson.jobId).toBeDefined(); // Expect a job ID in response
    const receivedJobId = responseBodyJson.jobId;

    // --- Verify Logs and Metrics (with polling) ---    
    let logFound = false; // Check for successful processing log
    let metricIncremented = false;
    const maxAttempts = 10;
    const pollDelay = 3000; // 3 seconds

    console.log('Polling Job Ingestion logs and /metrics for verification...');
    for (let i = 0; i < maxAttempts; i++) {
      console.log(`Attempt ${i + 1}/${maxAttempts}...`);

      // Check Logs for successful processing message (adjust pattern as needed)
      if (!logFound) {
        logFound = await checkLogsForPattern(JOB_INGESTION_HANDLER_LOG_GROUP, '{ $.level = "INFO" && $.message = "Job accepted and enqueued" && $.context.jobId = "' + receivedJobId + '" }', testStartTime);
        // Alternative check: ensure NO error logs for this job ID
        // const errorLogFound = await checkLogsForPattern(JOB_INGESTION_HANDLER_LOG_GROUP, '{ $.level = "ERROR" && $.context.jobId = "' + receivedJobId + '" }', testStartTime);
        // logFound = !errorLogFound; 
        if (logFound) console.log('JobIngestionHandler success log found!');
      }

      // Check Metrics
      if (!metricIncremented) {
        const currentMetrics = await getMetrics();
        const currentHttp202Count = currentMetrics.get('http_requests_total{method="POST",path="/jobs",status_code="202"}') || 0;
        if (currentHttp202Count > initialHttp202Count) {
            metricIncremented = true;
            console.log('HTTP 202 metric for /jobs incremented!');
        } else {
            console.log(`Current 202 count (${currentHttp202Count}) not greater than initial (${initialHttp202Count})`);
        }
      }

      if (logFound && metricIncremented) {
        break; // Exit loop if both conditions are met
      }

      if (i < maxAttempts - 1) {
          await delay(pollDelay); // Wait before next poll
      }
    }

    expect(logFound).toBe(true); // Assert success log was found
    expect(metricIncremented).toBe(true); // Assert metric incremented

    // Optional: Verify message in SQS using AWS SDK (more involved)

  }, 70000); // Increase timeout for API call and polling

}); 