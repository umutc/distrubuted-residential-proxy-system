import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { DynamoDBClient, QueryCommand, ScanCommand, QueryCommandOutput, ScanCommandOutput } from '@aws-sdk/client-dynamodb';
import { handler } from '../agent-monitoring'; // Adjust path
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, APIGatewayEventRequestContextV2 } from 'aws-lambda';
import { marshall, unmarshall as actualUnmarshall } from '@aws-sdk/util-dynamodb'; // Import marshall for creating mock items, rename actual unmarshall
import ActualLogger from '../../utils/logger'; // Import actual logger type

// --- Mocks ---
const mockLogger = {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
};
vi.mock('../../utils/logger', () => ({ default: mockLogger }));

vi.mock('@aws-sdk/client-dynamodb');

// Mock util-dynamodb specifically for unmarshall if needed, but often testing the input/output of the handler is sufficient
// If we mock unmarshall, ensure it behaves reasonably for the test cases.
const mockUnmarshall = vi.fn().mockImplementation((item) => actualUnmarshall(item)); // Use actual unmarshall by default for simplicity
vi.mock('@aws-sdk/util-dynamodb', async (importOriginal) => {
    const original = await importOriginal<typeof import('@aws-sdk/util-dynamodb')>();
    return {
        ...original,
        unmarshall: mockUnmarshall, // Allow overriding unmarshall mock per test if needed
    };
});

const mockDynamoDbClient = mockDeep<DynamoDBClient>();
const MockQueryCommand = vi.fn();
const MockScanCommand = vi.fn();

vi.mocked(DynamoDBClient).mockImplementation(() => mockDynamoDbClient);
vi.mocked(QueryCommand).mockImplementation((...args) => new MockQueryCommand(...args) as any);
vi.mocked(ScanCommand).mockImplementation((...args) => new MockScanCommand(...args) as any);

// --- Tests ---
describe('Agent Monitoring Handler', () => {
    const MOCK_TABLE_NAME = 'mock-agent-registry';
    let mockEvent: APIGatewayProxyEventV2;

    // Helper to create mock *unmarshalled* agent data
    const createMockAgentData = (id: string, status: string) => ({
        connectionId: `conn-${id}`,
        agentId: `agent-${id}`,
        status: status,
        connectedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 3600,
    });

    beforeAll(() => {
        process.env.AGENT_REGISTRY_TABLE_NAME = MOCK_TABLE_NAME;
    });

    beforeEach(() => {
        vi.clearAllMocks();
        MockQueryCommand.mockClear();
        MockScanCommand.mockClear();
        mockUnmarshall.mockClear(); // Clear unmarshall mock calls
        // Reset send mock for each test
        mockDynamoDbClient.send.mockReset();

        // Default mock event
        const mockRequestContext: APIGatewayEventRequestContextV2 = {
            accountId: '123456789012',
            apiId: 'test-api',
            domainName: 'test.domain',
            domainPrefix: 'test',
            http: {
                method: 'GET',
                path: '/agents',
                protocol: 'HTTP/1.1',
                sourceIp: '127.0.0.1',
                userAgent: 'test-agent'
            },
            requestId: 'test-req-id',
            routeKey: '$default',
            stage: 'dev',
            time: new Date().toISOString(),
            timeEpoch: Date.now(),
        };

        mockEvent = {
            version: '2.0',
            routeKey: '$default',
            rawPath: '/agents',
            rawQueryString: '', // Added missing property
            headers: {},
            queryStringParameters: {},
            requestContext: mockRequestContext,
            isBase64Encoded: false,
        };
    });

    // Helper to assert result structure
    const expectResultStructure = (result: APIGatewayProxyResultV2 | string | void | null | undefined) => {
        expect(result).toBeDefined();
        expect(typeof result).toBe('object');
        expect(result).toHaveProperty('statusCode');
        expect(result).toHaveProperty('body');
        return result as { statusCode: number; body: string }; 
    }

    it('should perform a Scan when no status filter is provided', async () => {
        const agent1 = createMockAgentData('1', 'active');
        const agent2 = createMockAgentData('2', 'busy');
        const mockItems = [marshall(agent1), marshall(agent2)]; // Marshall data for mock response
        const mockOutput: ScanCommandOutput = { Items: mockItems, $metadata: {} };
        mockDynamoDbClient.send.mockResolvedValue(mockOutput);

        const rawResult = await handler(mockEvent);
        const result = expectResultStructure(rawResult);
        const body = JSON.parse(result.body);

        expect(result.statusCode).toBe(200);
        expect(ScanCommand).toHaveBeenCalledTimes(1);
        expect(QueryCommand).not.toHaveBeenCalled();
        expect(mockDynamoDbClient.send).toHaveBeenCalledTimes(1);
        expect(body.agents).toHaveLength(2);
        // Use actual unmarshall, so result should match input data
        expect(body.agents[0]).toEqual(expect.objectContaining(agent1)); 
        expect(body.agents[1]).toEqual(expect.objectContaining(agent2));
        expect(body.nextToken).toBeNull();
        expect(mockLogger.info).toHaveBeenCalledWith('Scanning AgentRegistryTable');
    });

    it('should perform a Query when a status filter is provided', async () => {
        mockEvent.queryStringParameters = { status: 'active' };
        mockEvent.rawQueryString = 'status=active'; // Update raw query string
        const agent1 = createMockAgentData('1', 'active');
        const mockItems = [marshall(agent1)];
        const mockOutput: QueryCommandOutput = { Items: mockItems, $metadata: {} };
        mockDynamoDbClient.send.mockResolvedValue(mockOutput);

        const rawResult = await handler(mockEvent);
        const result = expectResultStructure(rawResult);
        const body = JSON.parse(result.body);

        expect(result.statusCode).toBe(200);
        expect(QueryCommand).toHaveBeenCalledTimes(1);
        expect(ScanCommand).not.toHaveBeenCalled();
        expect(mockDynamoDbClient.send).toHaveBeenCalledTimes(1);
        const commandArgs = MockQueryCommand.mock.calls[0][0];
        expect(commandArgs.IndexName).toBe('StatusIndex');
        expect(commandArgs.KeyConditionExpression).toBe('#status = :statusVal');
        expect(commandArgs.ExpressionAttributeValues[':statusVal'].S).toBe('active');
        expect(body.agents).toHaveLength(1);
        expect(body.agents[0].status).toBe('active');
        expect(body.agents[0]).toEqual(expect.objectContaining(agent1));
        expect(body.nextToken).toBeNull();
        expect(mockLogger.info).toHaveBeenCalledWith({ statusFilter: 'active' }, 'Querying AgentRegistryTable using StatusIndex');
    });

    it('should handle pagination with nextToken (Scan)', async () => {
        const lastEvaluatedKeyRaw = { connectionId: 'conn-1' }; // Unmarshalled key
        const lastEvaluatedKeyMarshalled = marshall(lastEvaluatedKeyRaw); // Marshalled key for response
        const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKeyMarshalled)).toString('base64'); // Encode marshalled key
        mockEvent.queryStringParameters = { nextToken: encodedToken };
        mockEvent.rawQueryString = `nextToken=${encodedToken}`;
        
        const agent2 = createMockAgentData('2', 'active');
        const mockItems = [marshall(agent2)];
        const mockOutput: ScanCommandOutput = { Items: mockItems, $metadata: {} }; // No LastEvaluatedKey in this response
        mockDynamoDbClient.send.mockResolvedValue(mockOutput);

        await handler(mockEvent);

        expect(ScanCommand).toHaveBeenCalledTimes(1);
        const commandArgs = MockScanCommand.mock.calls[0][0];
        // The command receives the *marshalled* key parsed from the token
        expect(commandArgs.ExclusiveStartKey).toEqual(lastEvaluatedKeyMarshalled);
    });

    it('should handle pagination with nextToken (Query)', async () => {
        const lastEvaluatedKeyRaw = { connectionId: 'conn-1', status: 'active' }; // GSI key + table PK (unmarshalled)
        const lastEvaluatedKeyMarshalled = marshall(lastEvaluatedKeyRaw);
        const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKeyMarshalled)).toString('base64');
        mockEvent.queryStringParameters = { status: 'active', nextToken: encodedToken };
        mockEvent.rawQueryString = `status=active&nextToken=${encodedToken}`;

        const agent2 = createMockAgentData('2', 'active');
        const mockItems = [marshall(agent2)];
        const mockOutput: QueryCommandOutput = { Items: mockItems, $metadata: {} };
        mockDynamoDbClient.send.mockResolvedValue(mockOutput);

        await handler(mockEvent);

        expect(QueryCommand).toHaveBeenCalledTimes(1);
        const commandArgs = MockQueryCommand.mock.calls[0][0];
        expect(commandArgs.ExclusiveStartKey).toEqual(lastEvaluatedKeyMarshalled);
    });

    it('should return nextToken when LastEvaluatedKey is present in response', async () => {
        const agent1 = createMockAgentData('1', 'active');
        const mockItems = [marshall(agent1)];
        const lastEvaluatedKeyMarshalled = marshall({ connectionId: 'conn-1' }); // Marshalled key
        const mockOutput: ScanCommandOutput = { Items: mockItems, LastEvaluatedKey: lastEvaluatedKeyMarshalled, $metadata: {} };
        mockDynamoDbClient.send.mockResolvedValue(mockOutput);

        const rawResult = await handler(mockEvent);
        const result = expectResultStructure(rawResult);
        const body = JSON.parse(result.body);

        expect(result.statusCode).toBe(200);
        expect(body.agents).toHaveLength(1);
        const expectedToken = Buffer.from(JSON.stringify(lastEvaluatedKeyMarshalled)).toString('base64');
        expect(body.nextToken).toBe(expectedToken);
    });

    it('should use default limit if not provided', async () => {
        const mockOutput: ScanCommandOutput = { Items: [], $metadata: {} };
        mockDynamoDbClient.send.mockResolvedValue(mockOutput);
        await handler(mockEvent);
        expect(ScanCommand).toHaveBeenCalledTimes(1);
        const commandArgs = MockScanCommand.mock.calls[0][0];
        expect(commandArgs.Limit).toBe(20); // Default limit
    });

    it('should use provided limit parameter', async () => {
        mockEvent.queryStringParameters = { limit: '10' };
        mockEvent.rawQueryString = 'limit=10';
        const mockOutput: ScanCommandOutput = { Items: [], $metadata: {} };
        mockDynamoDbClient.send.mockResolvedValue(mockOutput);
        await handler(mockEvent);
        expect(ScanCommand).toHaveBeenCalledTimes(1);
        const commandArgs = MockScanCommand.mock.calls[0][0];
        expect(commandArgs.Limit).toBe(10);
    });

    it('should return 400 for invalid limit parameter', async () => {
        mockEvent.queryStringParameters = { limit: '-5' };
        mockEvent.rawQueryString = 'limit=-5';
        const rawResult = await handler(mockEvent);
        const result = expectResultStructure(rawResult);
        expect(result.statusCode).toBe(400);
        expect(JSON.parse(result.body).message).toBe('Invalid limit parameter.');
        expect(mockDynamoDbClient.send).not.toHaveBeenCalled();
    });

    it('should return 500 if table name is not set', async () => {
        const originalTableName = process.env.AGENT_REGISTRY_TABLE_NAME;
        delete process.env.AGENT_REGISTRY_TABLE_NAME;
        
        const rawResult = await handler(mockEvent);
        const result = expectResultStructure(rawResult);
        
        process.env.AGENT_REGISTRY_TABLE_NAME = originalTableName;

        expect(result.statusCode).toBe(500);
        expect(JSON.parse(result.body).message).toContain('Table name not configured');
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'ORC-CFG-1001' }), expect.any(String));
        expect(mockDynamoDbClient.send).not.toHaveBeenCalled();
    });

    it('should return 500 on generic DynamoDB failure', async () => {
        const genericError = new Error('DynamoDB failed');
        mockDynamoDbClient.send.mockRejectedValueOnce(genericError);

        const rawResult = await handler(mockEvent);
        const result = expectResultStructure(rawResult);

        expect(result.statusCode).toBe(500);
        expect(JSON.parse(result.body).message).toContain('Internal server error');
        expect(mockDynamoDbClient.send).toHaveBeenCalledTimes(1);
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'ORC-DEP-1004' }), expect.any(String));
    });

}); 