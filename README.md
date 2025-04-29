# Distributed Residential Proxy System

A system designed for managing and utilizing a pool of geographically diverse residential IP addresses for executing outbound HTTP(S) requests. It allows internal cloud services (e.g., AWS Lambda) to make requests that appear to originate from standard home internet connections, avoiding blocks and rate limits associated with datacenter IPs.

This project is managed using [Task Master](README-task-master.md) for AI-driven development.

## 🚀 Project Status

[![Project Status](https://img.shields.io/badge/status-MVP%20Development-blue)](https://github.com/umutc/distrubuted-residential-proxy-system)

> The project is currently focused on building the Minimum Viable Product (MVP) features outlined in the PRD.

## ⏳ Timeline

-   **Current Phase:** MVP Implementation (See Tasks 1-10)
-   **Focus:** Core functionality for agent connection, job proxying (sync), and basic management.
-   **Next Steps (Post-MVP):** Asynchronous job handling, enhanced monitoring, scalability improvements (See PRD Section 5.2).

## 📊 Progress

**Overall MVP Completion: ~75%**

```
[███████████████░░░░░] 75% 
```
*(Based on Task Master task statuses)*

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
    -   ✅ Task 8: Implement synchronous job request/response flow (MVP level)
    -   ✅ Task 10: Implement comprehensive error handling and logging (Subtasks 10.1-10.5, 10.7-10.9 completed)

-   **Current Priorities:**
    -   ⏱️ Task 9: Create basic agent monitoring endpoint
    -   ⏱️ Task 10: Remaining subtasks (retry enhancements, shutdown logic, metrics, docs, tests)

## Core Features (MVP)

-   **Agent Connection & Authentication:** Lightweight Node.js agents running on operator machines connect securely to a central Orchestrator via WebSocket (WSS) using API keys. Includes reconnection logic.
-   **Job Distribution:** The Orchestrator receives HTTP request jobs (URL, method, headers, body) via an internal API.
-   **Job Execution:** The Orchestrator assigns jobs to available, authenticated Agents, marking them as busy. Agents execute the HTTP(S) requests using their residential IP address and follow redirects.
-   **Response Handling:** Agents return the response (status, headers, Base64-encoded body) or error to the Orchestrator via WebSocket.
-   **Synchronous API:** The Orchestrator provides a synchronous API (`POST /jobs?sync=true`) for internal services to submit jobs and receive proxied responses directly, waiting for completion.
-   **Health Check:** An HTTP endpoint (`GET /health`) on the Orchestrator to verify the status of core dependencies (DynamoDB tables, SQS queue).
-   **CloudWatch Metrics:** Basic metrics for synchronous job duration and success/failure/timeout status (`SynchronousJobDuration`, `SynchronousJobResult`) are published to CloudWatch under the `DistributedResidentialProxy` namespace.
-   **Resilience:** 
    -   Main job queue includes a Dead Letter Queue (DLQ).
    -   Basic retry logic for transient errors in the Orchestrator (e.g., no available agents).
-   **Agent Management:** Basic tracking of connected agents and their status (available/busy, basic health via status updates) within the Orchestrator.
-   **Structured Logging:** JSON-based structured logging implemented in both Agent and Orchestrator using Pino for better observability.
-   **Error Handling:** Defined error codes and enhanced error handling/logging across components.
-   **Configuration:** Agent configuration (Orchestrator URL, API Key) managed via environment variables.
-   **Monitoring:** 
    -   Basic API endpoint on the Orchestrator to list connected agents.
    -   Agent periodically sends status updates to Orchestrator.
-   **Timeout Handling:** Orchestrator implements timeouts for jobs sent to agents.

## Architecture Overview

The system consists of two main components:

1.  **Orchestrator:** A central service hosted on AWS defined by the Infrastructure as Code (IaC) in the root `/iac` directory (using AWS CDK). It likely uses API Gateway (WebSocket & HTTP) and Lambda/ECS Fargate for compute. It handles:
    -   Agent authentication and connection management via WebSocket.
    -   Receiving jobs from internal services via an HTTP API.
    -   Distributing jobs to connected Agents via WebSocket.
    -   Receiving responses from Agents.
    -   Returning responses to the originating service.
    -   Maintaining an Agent registry (in-memory for MVP).
    -   Providing a monitoring endpoint.
2.  **Agent:** A lightweight Node.js application (code located in `/agent`) designed to run on operator machines (Windows, macOS, Linux) with residential internet connections. It handles:
    -   Connecting to the Orchestrator via WebSocket (WSS).
    -   Authenticating using an `AGENT_KEY`.
    -   Receiving job details from the Orchestrator.
    -   Executing the specified HTTP(S) request locally using its residential IP (using `undici` or `node-fetch`).
    -   Sending the response back to the Orchestrator.
    -   Reading configuration (`ORCH_WS`, `AGENT_KEY`) from an `.env` file within the `/agent` directory.

## Setup

1.  **Prerequisites:**
    -   Node.js (v14.0.0 or higher recommended for Agent).
    -   AWS Account (for deploying the Orchestrator).
    -   Task Master CLI (optional, for manual task management): `npm install -g task-master-ai`
    -   Anthropic API Key (if using Task Master AI features): Set `ANTHROPIC_API_KEY` environment variable.

2.  **Orchestrator Deployment:**
    -   Navigate to the root `/iac` directory: `cd iac`.
    -   Install CDK dependencies: `npm install`.
    -   Configure AWS credentials for your target account/region.
    -   Deploy the stack: `cd iac && cdk deploy --require-approval never`. *Note: This command deploys all infrastructure, including Lambdas, API Gateways, SQS Queues, and DynamoDB tables.*
    -   The deployment outputs will include the Orchestrator WebSocket URL (`wss://...`) and the Job Ingestion HTTP API endpoint (`https://...`).
    -   Configure secure storage for Agent API keys (e.g., AWS Secrets Manager) - the stack creates a secret named `distributed-res-proxy-agent-keys`.
    -   Add API keys for your agents to the `distributed-res-proxy-agent-keys` secret in AWS Secrets Manager.

3.  **Agent Setup:**
    -   Clone this repository.
    -   Navigate to the Agent directory: `cd agent`.
    -   Install dependencies: `npm install`.
    -   Create a `.env` file in the `/agent` directory with:
        ```dotenv
        ORCH_WS=wss://your-orchestrator-websocket-url-from-cdk-output # e.g., wss://g0u8826061.execute-api.us-west-2.amazonaws.com/dev
        AGENT_KEY=your-provisioned-agent-api-key-from-secrets-manager
        AGENT_GRACE_PERIOD_MS=10000 # Optional: Grace period in ms for shutdown (default: 10000)
        ```
    -   Build the agent (if needed): `npm run build`
    -   Run the Agent: `node dist/agent.js`.

## Usage

1.  **Running the Agent:** Ensure the Orchestrator is deployed and the agent's `.env` file is configured correctly. Start the Agent application (`cd agent && node dist/agent.js`). It must be running and connected for jobs to be processed.

2.  **Submitting Jobs (Internal Services):**
    *   **Asynchronous (Recommended for non-interactive tasks):** Send a `POST` request to the Job Ingestion API endpoint (e.g., `https://your-http-api-id.execute-api.{region}.amazonaws.com/jobs`). The API will return `202 Accepted` with a `jobId`. Results must be retrieved separately (mechanism TBD post-MVP).
        ```bash
        curl -X POST https://{api-id}.execute-api.{region}.amazonaws.com/jobs \
             -H "Content-Type: application/json" \
             -d '{"url": "https://httpbin.org/delay/1", "method": "GET"}'
        ```
    *   **Synchronous:** Send a `POST` request to the same endpoint but include the query parameter `?sync=true`. The API will hold the connection open and return the proxied response (or an error/timeout) directly.
        ```bash
        curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/jobs?sync=true" \
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
    curl https://{api-id}.execute-api.{region}.amazonaws.com/health
    # Example Response: {"status":"healthy","checks":{"AgentRegistryTable":"OK","SyncJobMappingTable":"OK"}}
    ```

4.  **Monitoring:**
    *   Check CloudWatch Logs for Lambda functions (`ConnectHandler`, `DisconnectHandler`, `DefaultHandler`, `JobIngestionHandler`, `OrchestratorDispatcherHandler`, `HealthCheckHandler`).
    *   Check CloudWatch Metrics in the `DistributedResidentialProxy` namespace for `SynchronousJobDuration` and `SynchronousJobResult`.
    *   Monitor the `OrchestratorInputDLQ` SQS queue for messages that failed processing repeatedly.

5.  **Agent Monitoring:** Query the Orchestrator's monitoring endpoint (e.g., `GET /agents`) to see a list of connected agents and their status (covered in Task 9).

6.  **Task Management (Development):**
    -   This project uses [Task Master](README-task-master.md) for managing development tasks.
    -   Use `task-master list` or `task-master next` (or the corresponding MCP tools in Cursor) to view and manage tasks.
    -   See `README-task-master.md` for detailed Task Master commands and workflow.

## Integration Testing

-   Integration tests using Jest are located in `iac/test/integration.test.ts`.
-   These tests interact with the *deployed* HTTP API endpoint.
-   **Crucially, a live agent must be running and connected to the deployed WebSocket endpoint for the synchronous tests to pass.**
-   To run the tests:
    ```bash
    cd iac
    npm run test -- integration.test.ts
    ```

## Contributing

*(Guidelines for contributing to the project, if applicable)*

## License

*(Specify the project license)* 