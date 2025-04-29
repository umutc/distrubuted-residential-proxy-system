# Distributed Residential Proxy System

A system designed for managing and utilizing a pool of geographically diverse residential IP addresses for executing outbound HTTP(S) requests. It allows internal cloud services (e.g., AWS Lambda) to make requests that appear to originate from standard home internet connections, avoiding blocks and rate limits associated with datacenter IPs.

This project is managed using [Task Master](README-task-master.md) for AI-driven development.

## 🚀 Project Status

[![Project Status](https://img.shields.io/badge/status-MVP%20Completed-brightgreen)](https://github.com/umutc/distrubuted-residential-proxy-system)

> The core MVP features are implemented, tested (unit tests), and documented. The system is ready for initial deployment and integration testing.

## ⏳ Timeline

-   **Current Phase:** Completed
-   **Focus:** MVP feature set is implemented and unit tested.
-   **Next Steps:** Deployment, full integration testing with live agents, addressing deferred items (Agent-side heartbeat sending, Test Framework setup for more advanced tests), and potential post-MVP enhancements.

## 📊 Progress

**Overall MVP Completion: 100%**

```
[████████████████████] 100%
```
*(Based on Task Master task statuses for the defined MVP scope)*

-   **Completed Tasks:**
    -   ✅ Project Setup & Git Initialization
    -   ✅ Initial Task Generation from PRD
    -   ✅ Task 1: Set up Orchestrator WebSocket infrastructure
    -   ✅ Task 2: Implement Agent authentication and registration
    -   ✅ Task 3: Develop basic Agent application
    -   ✅ Task 4: Implement job distribution from Orchestrator to Agent
    -   ✅ Task 5: Implement HTTP request execution in Agent
    -   ✅ Task 6: Implement job response handling in Orchestrator
    -   ✅ Task 7: Develop Job Ingestion API endpoint
    -   ✅ Task 8: Implement synchronous job request/response flow
    -   ✅ Task 9: Implement agent monitoring endpoint & heartbeat handling (Orchestrator side)
    -   ✅ Task 10: Implement comprehensive error handling and logging
    -   ✅ Task 11 (Implied): Implement Unit Tests for critical handlers (Connect, Disconnect, Heartbeat, Monitoring)

-   **Deferred Tasks (Post-MVP / Requires Agent Implementation):**
    -   ⏳ Agent Heartbeat Sending (Agent-side implementation)
    -   ⏳ Test Framework Setup (For advanced integration/E2E tests)
    -   ⏳ API Documentation (OpenAPI Spec consolidation)
    -   ⏳ Performance Optimization Review

## Core Features (MVP)

-   **Agent Connection & Authentication:** Lightweight Node.js agents connect securely via WebSocket (WSS) using API keys.
-   **Job Distribution:** Orchestrator receives HTTP jobs via internal API.
-   **Job Execution:** Orchestrator assigns jobs to available Agents; Agents execute requests using residential IPs.
-   **Response Handling:** Agents return responses (status, headers, Base64 body) or errors to Orchestrator.
-   **Synchronous API:** `POST /jobs?sync=true` for submitting jobs and waiting for results.
-   **Health Check:** `GET /health` endpoint for Orchestrator dependency status.
-   **CloudWatch Metrics:** Basic metrics for sync job duration/results (`DistributedResidentialProxy` namespace).
-   **Agent Registry:** DynamoDB table (`AgentRegistryTable`) tracks agent `connectionId`, `status`, `connectedAt`, `lastHeartbeat`, `ttl`.
    -   Includes `StatusIndex` GSI for querying by status.
    -   TTL enabled on `ttl` attribute for automatic cleanup.
-   **Resilience:** Basic DLQ for input queue, retry logic.
-   **Structured Logging:** Pino-based JSON logging in Agent & Orchestrator.
-   **Error Handling:** Defined error codes, enhanced handling.
-   **Configuration:** Environment variables for Agent/Orchestrator.
-   **Monitoring:**
    -   **`GET /agents` Endpoint:** Provides a paginated list of registered agents, filterable by `status`.
    -   **Agent Heartbeat Handling:** Orchestrator updates `lastHeartbeat` and `ttl` on receiving `heartbeat` messages.
-   **Timeout Handling:** Orchestrator manages job timeouts.
-   **Unit Testing:** Core handlers (Connect, Disconnect, Heartbeat, Agent Monitoring) have unit tests using Vitest.

## Architecture Overview

The system consists of two main components:

1.  **Orchestrator:** A central service hosted on AWS defined by the Infrastructure as Code (IaC) in the root `/iac` directory (using AWS CDK). It uses API Gateway (WebSocket & HTTP), Lambda functions (located in `/iac/lambda`), SQS, and DynamoDB. It handles:
    -   Agent authentication and connection management via WebSocket.
    -   Receiving jobs from internal services via an HTTP API.
    -   Distributing jobs to connected Agents via WebSocket.
    -   Receiving responses from Agents.
    -   Returning responses to the originating service.
    -   Maintaining an Agent registry (in DynamoDB).
    -   Providing health check and monitoring endpoints.
2.  **Agent:** A lightweight Node.js application (source code located in the `/agent` directory) designed to run on operator machines (Windows, macOS, Linux) with residential internet connections. It handles:
    -   Connecting to the Orchestrator via WebSocket (WSS).
    -   Authenticating using an `AGENT_KEY`.
    -   Receiving job details from the Orchestrator.
    -   Executing the specified HTTP(S) request locally using its residential IP (using `undici`).
    -   Sending the response back to the Orchestrator.
    -   Reading configuration (`ORCH_WS`, `AGENT_KEY`) from an `.env` file within the `/agent` directory.

*(Note: The project structure was recently cleaned. The top-level `/src` directory was removed as orchestrator code resides in `/iac/lambda` and agent code in `/agent/src`.)*

## Setup

1.  **Prerequisites:**
    -   Node.js (v18.x or higher recommended).
    -   AWS Account & AWS CLI configured (for deploying the Orchestrator).
    -   Task Master CLI (optional, for manual task management): `npm install -g task-master-ai`
    -   Anthropic API Key (if using Task Master AI features): Set `ANTHROPIC_API_KEY` environment variable.

2.  **Orchestrator Deployment:**
    -   Navigate to the root `/iac` directory: `cd iac`.
    -   Install CDK dependencies: `npm install`.
    -   Configure AWS credentials for your target account/region.
    -   Deploy the stack: `cdk deploy --require-approval never`. *Note: This command deploys all infrastructure, including Lambdas, API Gateways, SQS Queues, and DynamoDB tables.* 
    -   The deployment outputs will include the Orchestrator WebSocket URL (`wss://...`, look for `WebSocketApiUrl` output) and the Job Ingestion HTTP API endpoint (`https://...`, look for `HttpApiUrl` output).
    -   Configure secure storage for Agent API keys (e.g., AWS Secrets Manager) - the stack creates a secret named `distributed-res-proxy-agent-keys`.
    -   Add API keys for your agents to the `distributed-res-proxy-agent-keys` secret in AWS Secrets Manager (e.g., using the AWS console or CLI).

3.  **Agent Setup:**
    -   Clone this repository.
    -   Navigate to the Agent directory: `cd agent`.
    -   Install dependencies: `npm install`.
    -   Create a `.env` file in the `/agent` directory with:
        ```dotenv
        ORCH_WS=wss://your-websocket-api-url/ # From CDK Output WebSocketApiUrl
        AGENT_KEY=your-provisioned-agent-api-key-from-secrets-manager
        AGENT_GRACE_PERIOD_MS=10000 # Optional: Grace period in ms for shutdown (default: 10000)
        ```
    -   Build the agent (if needed, typically handled automatically): `npm run build`
    -   Run the Agent: `node dist/agent.js`.

## Usage

1.  **Running the Agent:** Ensure the Orchestrator is deployed and the agent's `.env` file is configured correctly. Start the Agent application (`cd agent && node dist/agent.js`). It must be running and connected for jobs to be processed.

2.  **Submitting Jobs (Internal Services):**
    *   **Asynchronous (Recommended for non-interactive tasks):** Send a `POST` request to the Job Ingestion API endpoint (e.g., `https://your-http-api-id.execute-api.{region}.amazonaws.com/jobs`). The API will return `202 Accepted` with a `jobId`. Results must be retrieved separately (mechanism TBD post-MVP).
        ```bash
        curl -X POST https://{your-http-api-url}/jobs \
             -H "Content-Type: application/json" \
             -d '{"url": "https://httpbin.org/delay/1", "method": "GET"}'
        ```
    *   **Synchronous:** Send a `POST` request to the same endpoint but include the query parameter `?sync=true`. The API will hold the connection open and return the proxied response (or an error/timeout) directly.
        ```bash
        curl -X POST "https://{your-http-api-url}/jobs?sync=true" \
             -H "Content-Type: application/json" \
             -d '{"url": "https://httpbin.org/get", "method": "GET"}'

        # Example Success Response (Body contains JSON string)
        # {
        #   "message": "Job completed successfully.",
        #   "jobId": "...",
        #   "requestId": "...",
        #   "result": {
        #     "statusCode": 200,
        #     "headers": { ... },
        #     "body": "eyJhcmdzIj...", // Base64 encoded
        #     "isBase64Encoded": true
        #   }
        # }

        # Example Timeout Response
        # {
        #   "message": "Request timed out waiting for job completion.",
        #   "jobId": "...",
        #   "requestId": "..."
        # }
        ```

3.  **Health Check:** Send a `GET` request to the `/health` endpoint of the HTTP API.
    ```bash
    curl https://{your-http-api-url}/health
    # Example Response: {"status":"healthy","checks":{"AgentRegistryTable":"OK","SyncJobMappingTable":"OK"}}
    ```

4.  **Monitoring:**
    *   Check CloudWatch Logs for Lambda functions.
    *   Check CloudWatch Metrics in the `DistributedResidentialProxy` namespace.
    *   Monitor the `OrchestratorInputDLQ` SQS queue.
    *   **Agent Monitoring:** Query the Orchestrator's monitoring endpoint (`GET /agents`) to see a list of agents.
        ```bash
        # Get all agents (paginated)
        curl https://{your-http-api-url}/agents 
        # Get active agents, limit to 5
        curl "https://{your-http-api-url}/agents?status=active&limit=5"
        ```

5.  **Task Management (Development):**
    -   This project uses [Task Master](README-task-master.md) for managing development tasks.
    -   Use `task-master list` or `task-master next` (or the corresponding MCP tools in Cursor) to view and manage tasks.
    -   See `README-task-master.md` for detailed Task Master commands and workflow.

## Testing

-   **Unit Tests:** Located in `iac/lambda/handlers/test/`. Uses Vitest for testing individual Lambda handlers with mocks.
    -   Run specific file: `npm test -- iac/lambda/handlers/test/handler-name.test.ts`
    -   Run all unit tests: `npm test -- iac/lambda/handlers/test` (or just `npm test` if integration tests are skipped)
-   **Integration Tests:** Located in `iac/test/integration/` and `iac/test/integration.test.ts`. These tests interact with deployed AWS resources.
    -   **Prerequisites:** Requires environment variables pointing to a deployed stack (e.g., `HTTP_API_URL`, `WEBSOCKET_API_URL`, `TEST_AGENT_KEY`, Queue URLs, Log Group Names). See test files for specific required variables.
    -   Requires a live agent running and connected using `TEST_AGENT_KEY` for some tests (e.g., synchronous job execution).
    -   Run all integration tests: `npm test -- iac/test/integration`

## Contributing

*(Guidelines for contributing to the project, if applicable)*

## License

*(Specify the project license)* 