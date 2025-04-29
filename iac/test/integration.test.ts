import { request, Dispatcher } from 'undici';
import * as cdk from 'aws-cdk-lib';
import { OrchestratorStack } from '../lib/iac-stack'; // Adjust path if needed
import { test, expect, describe, beforeAll, afterAll } from 'vitest'; // Add vitest imports

// Load from environment or use deployment output
const API_ENDPOINT = process.env.TEST_API_ENDPOINT || 'https://9785a0r334.execute-api.us-west-2.amazonaws.com';
const SYNC_JOB_URL = `${API_ENDPOINT}/jobs?sync=true`;
const ASYNC_JOB_URL = `${API_ENDPOINT}/jobs`;

// Define simple interfaces for expected responses (optional but good practice)
interface SuccessResponse {
    message: string;
    jobId: string;
    requestId: string;
    result: {
        statusCode: number;
        headers: Record<string, string>;
        body: string; // Base64 encoded
        isBase64Encoded?: boolean;
    }
}

interface ErrorResponse {
    message: string;
    jobId?: string;
    requestId?: string;
    agentErrorCode?: string;
    error?: string;
}

// Assume deployment outputs are available via environment variables or a config file
// For local testing against deployed resources, you might fetch these outputs
const HTTP_API_URL = process.env.HTTP_API_URL;
const WEBSOCKET_API_URL = process.env.WEBSOCKET_API_URL; // e.g., wss://...
const AGENT_KEY = process.env.TEST_AGENT_KEY; // A specific API key for testing

// Helper function to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Basic check for environment variables
if (!HTTP_API_URL || !WEBSOCKET_API_URL || !AGENT_KEY) {
    console.warn('Skipping integration tests: Required environment variables (HTTP_API_URL, WEBSOCKET_API_URL, TEST_AGENT_KEY) not set.');
    // Use describe.skip to skip tests if env vars are missing
    describe.skip('Distributed Proxy System - Integration Tests', () => {
        test.skip('Placeholder test', () => {});
    });
} else {
    // Only run tests if environment variables are set
    describe('Distributed Proxy System - Integration Tests', () => {

        // Test Case 1: Happy Path (Sync)
        test('should handle a synchronous GET request successfully', async () => {
            // Prerequisite: Ensure at least one agent with TEST_AGENT_KEY is running and connected
            
            const jobPayload = {
                url: 'https://httpbin.org/get',
                method: 'GET'
            };

            const response = await fetch(`${HTTP_API_URL}/jobs?sync=true`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(jobPayload)
            });

            expect(response.status).toBe(200);
            const responseBody = await response.json() as SuccessResponse; // Assert type

            expect(responseBody.message).toContain('Job completed successfully');
            expect(responseBody.jobId).toBeDefined();
            expect(responseBody.result).toBeDefined();
            expect(responseBody.result.statusCode).toBe(200);
            expect(responseBody.result.isBase64Encoded).toBe(true); // Assuming body is always base64
            // Further checks on the result body content if needed (after base64 decoding)
        }, 35000); // Increased timeout for sync request

        // Test Case 2: Sync Request Timeout
        test('should handle a synchronous request timeout', async () => {
            // Prerequisite: Ensure NO agents are running/connected or make the target URL very slow
            const jobPayload = {
                url: 'https://httpbin.org/delay/35', // URL that takes longer than default API Gateway/Lambda timeout
                method: 'GET'
            };

            const response = await fetch(`${HTTP_API_URL}/jobs?sync=true`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(jobPayload)
            });

            expect(response.status).toBe(500); // Or 504 Gateway Timeout depending on where it times out
            const responseBody = await response.json() as ErrorResponse; // Assert type
            expect(responseBody.message).toMatch(/timeout/i);
            expect(responseBody.jobId).toBeDefined();
        }, 40000);

        // Test Case 3: Health Check
        test('should return healthy status from health check endpoint', async () => {
            const response = await fetch(`${HTTP_API_URL}/health`);
            expect(response.status).toBe(200);
            const responseBody = await response.json() as { status: string; checks: Record<string, string> }; // Assert type
            expect(responseBody.status).toBe('healthy');
            expect(responseBody.checks).toBeDefined();
            // Add checks for specific dependencies if needed
        });

        // Test Case 4: Agent Error (Sync) - Target unreachable
        test('should return 5xx error for synchronous request to unreachable URL', async () => {
            const jobPayload = {
                url: 'https://nonexistent-domain-for-sure.xyz',
                method: 'GET'
            };

            const { statusCode, body } = await request(SYNC_JOB_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(jobPayload)
            });

            // Expecting a 502 Bad Gateway or potentially 504 Timeout depending on exact flow
            expect(statusCode).toBeGreaterThanOrEqual(500);
            const responseJson = await body.json() as ErrorResponse; // Cast
            expect(responseJson.message).toContain('Job failed during execution');
            expect(responseJson.agentErrorCode).toBeDefined(); // e.g., AGENT_TARGET_UNREACHABLE
            expect(responseJson.jobId).toBeDefined();
        }, 60000);

        // Test Case 5: Timeout (Sync)
        // Note: This relies on the combined timeout (job + API GW + Lambda) 
        // Or a specifically short job timeout if the agent honors it precisely.
        // Simulating requires a cooperative agent or a very slow endpoint.
        // Let's test the default 30s timeout path.
        test('should return 504 for synchronous request that exceeds timeout', async () => {
            const jobPayload = {
                url: 'https://httpbin.org/delay/45', // Request a delay longer than the typical ~29s limit
                method: 'GET'
                // timeoutMs: 5000 // Alternatively, set a short job timeout
            };

            const { statusCode, body } = await request(SYNC_JOB_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(jobPayload)
            });

            expect(statusCode).toBe(504); // Gateway Timeout
            const responseJson = await body.json() as ErrorResponse; // Cast
            expect(responseJson.message).toContain('Request timed out');
            expect(responseJson.jobId).toBeDefined();
        }, 60000); // Allow ample time for the timeout to occur

        // Test Case 6: Invalid Request (Sync)
        test('should return 400 for synchronous request with invalid payload', async () => {
            const invalidJobPayload = {
                // Missing URL
                method: 'GET'
            };

            const { statusCode, body } = await request(SYNC_JOB_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(invalidJobPayload)
            });

            expect(statusCode).toBe(400);
            const responseJson = await body.json() as ErrorResponse; // Cast
            expect(responseJson.message).toContain('Invalid request: Missing or invalid url');
        }, 60000);

        // Test Case 7: Happy Path (Async)
        test('should return 202 Accepted for a valid asynchronous request', async () => {
            const jobPayload = {
                url: 'https://httpbin.org/post',
                method: 'POST',
                body: JSON.stringify({ test: 'async' }),
                headers: { 'content-type': 'application/json' }
            };

            const { statusCode, body } = await request(ASYNC_JOB_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(jobPayload)
            });

            expect(statusCode).toBe(202);
            const responseJson = await body.json() as ErrorResponse; // Cast (async success has different shape)
            expect(responseJson.message).toBe('Job accepted and sent to orchestrator queue.');
            expect(responseJson.jobId).toBeDefined();
        }, 60000);

    });
} 