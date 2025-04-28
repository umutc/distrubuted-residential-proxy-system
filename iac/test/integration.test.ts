import { request, Dispatcher } from 'undici';

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

describe('Distributed Proxy System - Integration Tests', () => {

    // Test Case 1: Happy Path (Sync)
    test('should successfully process a valid synchronous GET request', async () => {
        const jobPayload = {
            url: 'https://httpbin.org/get',
            method: 'GET'
        };

        const { statusCode, body } = await request(SYNC_JOB_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(jobPayload)
        });

        expect(statusCode).toBe(200);
        const responseJson = await body.json() as SuccessResponse; // Cast to expected type
        expect(responseJson.message).toBe('Job completed successfully.');
        expect(responseJson.jobId).toBeDefined();
        expect(responseJson.result).toBeDefined();
        expect(responseJson.result.statusCode).toBe(200);
        expect(responseJson.result.body).toBeDefined();
        // Optionally decode base64 body and check content if needed
        // const decodedBody = Buffer.from(responseJson.result.body, 'base64').toString();
        // expect(decodedBody).toContain('"url": "https://httpbin.org/get"');
    }, 60000); // Use the increased timeout

    // Test Case 2: Agent Error (Sync) - Target unreachable
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

    // Test Case 3: Timeout (Sync)
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

    // Test Case 4: Invalid Request (Sync)
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

    // Test Case 5: Happy Path (Async)
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