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

**Overall MVP Completion: 70%**

```
[█████████████░░░░░░░] 70% 
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

-   **Current Priorities:**
    -   ⏱️ Task 8: Implement synchronous job request/response flow
    -   ⏱️ Task 9: Create basic agent monitoring endpoint
    -   ⏱️ Task 10: Implement job timeout mechanism

## Core Features (MVP)

-   **Agent Connection & Authentication:** Lightweight Node.js agents running on operator machines connect securely to a central Orchestrator via WebSocket (WSS) using API keys. Includes reconnection logic.
-   **Job Distribution:** The Orchestrator receives HTTP request jobs (URL, method, headers, body) via an internal API.
-   **Job Execution:** The Orchestrator assigns jobs to available, authenticated Agents, marking them as busy. Agents execute the HTTP(S) requests using their residential IP address and follow redirects.
-   **Response Handling:** Agents return the response (status, headers, Base64-encoded body) or error to the Orchestrator via WebSocket.
-   **Synchronous API:** The Orchestrator provides a synchronous API for internal services to submit jobs and receive proxied responses.
-   **Agent Management:** Basic tracking of connected agents and their status (available/busy) within the Orchestrator.
-   -   Lambda handlers use the `AGENT_REGISTRY_TABLE_NAME` environment variable to locate the agent registry DynamoDB table.
-   **Configuration:** Agent configuration (Orchestrator URL, API Key) managed via environment variables.
-   **Monitoring:** Basic API endpoint on the Orchestrator to list connected agents.
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
    -   Deploy the stack: `cdk deploy`.
    -   The deployment outputs will include the Orchestrator WebSocket URL (`wss://...`) and the Job Ingestion HTTP API endpoint (`https://...`).
    -   Configure secure storage for Agent API keys (e.g., AWS Secrets Manager) - the stack creates a secret named `distributed-res-proxy-agent-keys`.
    -   Add API keys for your agents to the `distributed-res-proxy-agent-keys` secret in AWS Secrets Manager.

3.  **Agent Setup:**
    -   Clone this repository.
    -   Navigate to the Agent directory: `cd agent`.
    -   Install dependencies: `npm install`.
    -   Create a `.env` file in the `/agent` directory with:
        ```dotenv
        ORCH_WS=wss://your-orchestrator-websocket-url-from-cdk-output
        AGENT_KEY=your-provisioned-agent-api-key-from-secrets-manager
        ```
    -   Run the Agent: `node dist/agent.js` (assuming a build step, or `ts-node src/agent.ts` for development).

## Usage

1.  **Running the Agent:** Once configured, start the Agent application on the operator's machine (`node dist/agent.js`). It will connect to the Orchestrator and become available for jobs. Logs will indicate connection status.

2.  **Submitting Jobs (Internal Services):** Internal services interact with the Orchestrator's job ingestion API (covered in Task 7 & 8). The API endpoint (e.g., `POST /jobs`) will accept a JSON payload like:
    ```json
    {
      "url": "https://example.com",
      "method": "GET",
      "headers": { "User-Agent": "MyApp/1.0" },
      "body": null // or Base64 encoded string for POST/PUT
    }
    ```
    The API will synchronously return the proxied response:
    ```json
    {
      "statusCode": 200,
      "headers": { "content-type": "text/html; charset=UTF-8", ... },
      "body": "PGh0bWw+..." // Base64 encoded body
    }
    ```
    Or an error object if the job fails or times out.

3.  **Monitoring:** Query the Orchestrator's monitoring endpoint (e.g., `GET /agents`) to see a list of connected agents and their status (covered in Task 9).

4.  **Task Management (Development):**
    -   This project uses [Task Master](README-task-master.md) for managing development tasks.
    -   Use `task-master list` or `task-master next` (or the corresponding MCP tools in Cursor) to view and manage tasks.
    -   See `README-task-master.md` for detailed Task Master commands and workflow.

## Contributing

*(Guidelines for contributing to the project, if applicable)*

## License

*(Specify the project license)* 