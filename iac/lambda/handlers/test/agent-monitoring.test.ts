import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
// Import concrete Command classes for instanceof checks
import { DynamoDBClient, QueryCommand, ScanCommand, QueryCommandOutput, ScanCommandOutput } from '@aws-sdk/client-dynamodb';
import { handler } from '../agent-monitoring';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, APIGatewayEventRequestContextV2 } from 'aws-lambda';
import { marshall, unmarshall as actualUnmarshall } from '@aws-sdk/util-dynamodb';
import ActualLogger from '../../utils/logger';

// --- Define Mock Variables (used in doMock factories) ---
const mockLoggerInstance = {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
};
const mockDynamoDbClientInstance = mockDeep<DynamoDBClient>();
const mockUnmarshall = vi.fn();
const MockQueryCommandInstance = vi.fn(); // Mock for constructor
const MockScanCommandInstance = vi.fn();  // Mock for constructor

// --- Test Suite ---
describe('Agent Monitoring Handler', () => {
    const MOCK_TABLE_NAME = 'mock-agent-registry';
    let mockEvent: APIGatewayProxyEventV2;
    let handler: typeof import('../agent-monitoring').handler;

    // Helper to create mock *unmarshalled* agent data
    const createMockAgentData = (id: string, status: string) => ({
        connectionId: `conn-${id}`,
        agentId: `agent-${id}`,
        status: status,
        connectedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 3600,
    });

    beforeAll(async () => {
        // Set Env Var FIRST, before any mocks or imports that might depend on it
        process.env.AGENT_REGISTRY_TABLE_NAME = MOCK_TABLE_NAME;
        
        // Reset mock implementations (needed before applying mocks)
        mockUnmarshall.mockImplementation((item) => actualUnmarshall(item));

        // Apply mocks dynamically
        vi.doMock('../../utils/logger', () => ({ default: mockLoggerInstance }));
        vi.doMock('@aws-sdk/util-dynamodb', async (importOriginal) => {
             const original = await importOriginal<typeof import('@aws-sdk/util-dynamodb')>();
             return { ...original, marshall: original.marshall, unmarshall: mockUnmarshall };
        });
        vi.doMock('@aws-sdk/client-dynamodb', async (importOriginal) => {
             const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
             return { ...actual, DynamoDBClient: actual.DynamoDBClient, QueryCommand: MockQueryCommandInstance, ScanCommand: MockScanCommandInstance };
        });

        // Import handler *after* mocks and setting env var
        const module = await import('../agent-monitoring');
        handler = module.handler;
    });

    afterAll(() => {
        // Unmock
        vi.doUnmock('../../utils/logger');
        vi.doUnmock('@aws-sdk/util-dynamodb');
        vi.doUnmock('@aws-sdk/client-dynamodb');
    });

    beforeEach(() => {
        // Ensure table name is set correctly before each test (might be redundant now but safe)
        process.env.AGENT_REGISTRY_TABLE_NAME = MOCK_TABLE_NAME; 
        // Clear mocks
        vi.clearAllMocks();
        mockUnmarshall.mockImplementation((item) => actualUnmarshall(item));
        mockDynamoDbClientInstance.send.mockReset();

        // Default mock event setup
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
            rawQueryString: '',
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

    // --- Test Cases --- 

    it('should perform a Scan when no status filter is provided', async () => {
        const agent1 = createMockAgentData('1', 'active');
        const agent2 = createMockAgentData('2', 'busy');
        const mockItems = [marshall(agent1), marshall(agent2)];
        const mockOutput: ScanCommandOutput = { Items: mockItems, $metadata: {} };
        mockDynamoDbClientInstance.send.mockResolvedValue(mockOutput as any);

        // Use the handler imported in beforeAll
        const rawResult = await handler(mockEvent, { dbClient: mockDynamoDbClientInstance, unmarshall: mockUnmarshall });
        const result = expectResultStructure(rawResult);
        const body = JSON.parse(result.body);

        expect(result.statusCode).toBe(200);
        expect(MockScanCommandInstance).toHaveBeenCalledTimes(1);
        expect(mockDynamoDbClientInstance.send).toHaveBeenCalledTimes(1);
        const sentCommand = mockDynamoDbClientInstance.send.mock.calls[0][0];
        expect(sentCommand).toBeInstanceOf(MockScanCommandInstance);
        expect(body.agents).toHaveLength(2);
        expect(body.agents[0]).toEqual(expect.objectContaining(agent1));
        expect(body.agents[1]).toEqual(expect.objectContaining(agent2));
        expect(body.nextToken).toBeNull();
        expect(mockLoggerInstance.info).toHaveBeenCalledWith('Scanning AgentRegistryTable');
    });

    it('should perform a Query when a status filter is provided', async () => {
        mockEvent.queryStringParameters = { status: 'active' };
        mockEvent.rawQueryString = 'status=active';
        const agent1 = createMockAgentData('1', 'active');
        const mockItems = [marshall(agent1)];
        const mockOutput: QueryCommandOutput = { Items: mockItems, $metadata: {} };
        mockDynamoDbClientInstance.send.mockResolvedValue(mockOutput as any);

        const rawResult = await handler(mockEvent, { dbClient: mockDynamoDbClientInstance, unmarshall: mockUnmarshall });
        const result = expectResultStructure(rawResult);
        const body = JSON.parse(result.body);

        expect(result.statusCode).toBe(200);
        expect(MockQueryCommandInstance).toHaveBeenCalledTimes(1);
        expect(mockDynamoDbClientInstance.send).toHaveBeenCalledTimes(1);
        const commandArgs = MockQueryCommandInstance.mock.calls[0][0];
        expect(commandArgs.TableName).toBe(MOCK_TABLE_NAME);
        expect(commandArgs.IndexName).toBe('StatusIndex');
        expect(commandArgs.KeyConditionExpression).toBe('#status = :statusVal');
        expect(commandArgs.ExpressionAttributeValues[':statusVal'].S).toBe('active');
        const sentCommand = mockDynamoDbClientInstance.send.mock.calls[0][0];
        expect(sentCommand).toBeInstanceOf(MockQueryCommandInstance);
        expect(body.agents).toHaveLength(1);
        expect(body.agents[0].status).toBe('active');
        expect(body.agents[0]).toEqual(expect.objectContaining(agent1));
        expect(body.nextToken).toBeNull();
        expect(mockLoggerInstance.info).toHaveBeenCalledWith({ statusFilter: 'active' }, 'Querying AgentRegistryTable using StatusIndex');
    });

    it('should handle pagination with nextToken (Scan)', async () => {
        const lastEvaluatedKeyRaw = { connectionId: 'conn-1' };
        const lastEvaluatedKeyMarshalled = marshall(lastEvaluatedKeyRaw);
        const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKeyMarshalled)).toString('base64');
        mockEvent.queryStringParameters = { nextToken: encodedToken };
        mockEvent.rawQueryString = `nextToken=${encodedToken}`;

        const agent2 = createMockAgentData('2', 'active');
        const mockItems = [marshall(agent2)];
        const mockOutput: ScanCommandOutput = { Items: mockItems, $metadata: {} };
        mockDynamoDbClientInstance.send.mockResolvedValue(mockOutput as any);

        await handler(mockEvent, { dbClient: mockDynamoDbClientInstance, unmarshall: mockUnmarshall });

        expect(MockScanCommandInstance).toHaveBeenCalledTimes(1);
        const commandArgs = MockScanCommandInstance.mock.calls[0][0];
        expect(commandArgs.ExclusiveStartKey).toEqual(lastEvaluatedKeyMarshalled);
        expect(mockDynamoDbClientInstance.send).toHaveBeenCalledTimes(1);
    });

    it('should handle pagination with nextToken (Query)', async () => {
        const lastEvaluatedKeyRaw = { connectionId: 'conn-1', status: 'active' };
        const lastEvaluatedKeyMarshalled = marshall(lastEvaluatedKeyRaw);
        const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKeyMarshalled)).toString('base64');
        mockEvent.queryStringParameters = { status: 'active', nextToken: encodedToken };
        mockEvent.rawQueryString = `status=active&nextToken=${encodedToken}`;

        const agent2 = createMockAgentData('2', 'active');
        const mockItems = [marshall(agent2)];
        const mockOutput: QueryCommandOutput = { Items: mockItems, $metadata: {} };
        mockDynamoDbClientInstance.send.mockResolvedValue(mockOutput as any);

        await handler(mockEvent, { dbClient: mockDynamoDbClientInstance, unmarshall: mockUnmarshall });

        expect(MockQueryCommandInstance).toHaveBeenCalledTimes(1);
        const commandArgs = MockQueryCommandInstance.mock.calls[0][0];
        expect(commandArgs.ExclusiveStartKey).toEqual(lastEvaluatedKeyMarshalled);
        expect(mockDynamoDbClientInstance.send).toHaveBeenCalledTimes(1);
    });

    it('should return nextToken when LastEvaluatedKey is present in response', async () => {
        const agent1 = createMockAgentData('1', 'active');
        const mockItems = [marshall(agent1)];
        const lastEvaluatedKeyMarshalled = marshall({ connectionId: 'conn-1' });
        const mockOutput: ScanCommandOutput = { Items: mockItems, LastEvaluatedKey: lastEvaluatedKeyMarshalled, $metadata: {} };
        mockDynamoDbClientInstance.send.mockResolvedValue(mockOutput as any);

        const rawResult = await handler(mockEvent, { dbClient: mockDynamoDbClientInstance, unmarshall: mockUnmarshall });
        const result = expectResultStructure(rawResult);
        const body = JSON.parse(result.body);

        expect(result.statusCode).toBe(200);
        expect(body.nextToken).toBeDefined();
        expect(typeof body.nextToken).toBe('string');
        const decoded = JSON.parse(Buffer.from(body.nextToken, 'base64').toString('utf8'));
        expect(decoded).toEqual(lastEvaluatedKeyMarshalled);
    });

    it('should return 500 and log error if table name is not set', async () => {
        const originalTableName = process.env.AGENT_REGISTRY_TABLE_NAME;
        delete process.env.AGENT_REGISTRY_TABLE_NAME;

        // Reset modules and re-apply mocks just for this test context
        vi.resetModules();
        vi.doMock('../../utils/logger', () => ({ default: mockLoggerInstance }));
        vi.doMock('@aws-sdk/util-dynamodb', async (importOriginal) => { 
            const original = await importOriginal<typeof import('@aws-sdk/util-dynamodb')>(); 
            return { 
                ...original, 
                marshall: original.marshall,
                unmarshall: mockUnmarshall
            }; 
        });
        vi.doMock('@aws-sdk/client-dynamodb', async (importOriginal) => { 
            const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>(); 
            return { 
                ...actual, 
                DynamoDBClient: actual.DynamoDBClient,
                QueryCommand: MockQueryCommandInstance, 
                ScanCommand: MockScanCommandInstance 
            }; 
        });

        const { handler: localHandler } = await import('../agent-monitoring');

        const rawResult = await localHandler(mockEvent, { dbClient: mockDynamoDbClientInstance, unmarshall: mockUnmarshall });
        const result = expectResultStructure(rawResult);

        // Restore env var and unmock
        process.env.AGENT_REGISTRY_TABLE_NAME = originalTableName;
        vi.doUnmock('../../utils/logger');
        vi.doUnmock('@aws-sdk/util-dynamodb');
        vi.doUnmock('@aws-sdk/client-dynamodb');
        vi.resetModules(); // Ensure clean state after this specific test

        expect(result.statusCode).toBe(500);
        expect(JSON.parse(result.body).message).toBe('Internal Server Error: Table name not configured.'); 
        expect(mockLoggerInstance.error).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'ORC-CFG-1001' }), 'AGENT_REGISTRY_TABLE_NAME environment variable not set.');
        expect(mockDynamoDbClientInstance.send).not.toHaveBeenCalled();
    });

    it('should return 500 and log error on DynamoDB Scan failure', async () => {
        const error = new Error('Scan failed');
        mockDynamoDbClientInstance.send.mockRejectedValue(error);

        const rawResult = await handler(mockEvent, { dbClient: mockDynamoDbClientInstance, unmarshall: mockUnmarshall });
        const result = expectResultStructure(rawResult);

        expect(result.statusCode).toBe(500);
        expect(JSON.parse(result.body).message).toBe('Internal Server Error retrieving agent data.'); // Use exact message
        expect(mockDynamoDbClientInstance.send).toHaveBeenCalledTimes(1);
        expect(MockScanCommandInstance).toHaveBeenCalledTimes(1); 
        expect(mockLoggerInstance.error).toHaveBeenCalledWith(
            expect.objectContaining({ errorCode: 'ORC-DEP-1002', error: 'Scan failed' }), 
            'Error querying/scanning Agent Registry Table'
        );
    });

    it('should return 500 and log error on DynamoDB Query failure', async () => {
        mockEvent.queryStringParameters = { status: 'active' };
        mockEvent.rawQueryString = 'status=active';
        const error = new Error('Query failed');
        mockDynamoDbClientInstance.send.mockRejectedValue(error);

        const rawResult = await handler(mockEvent, { dbClient: mockDynamoDbClientInstance, unmarshall: mockUnmarshall });
        const result = expectResultStructure(rawResult);

        expect(result.statusCode).toBe(500);
        expect(JSON.parse(result.body).message).toBe('Internal Server Error retrieving agent data.'); // Use exact message
        expect(mockDynamoDbClientInstance.send).toHaveBeenCalledTimes(1);
        expect(MockQueryCommandInstance).toHaveBeenCalledTimes(1); 
        expect(mockLoggerInstance.error).toHaveBeenCalledWith(
            expect.objectContaining({ errorCode: 'ORC-DEP-1002', error: 'Query failed' }), 
            'Error querying/scanning Agent Registry Table'
        );
    });

    it('should return 400 if invalid status is provided', async () => {
        mockEvent.queryStringParameters = { status: 'invalid_status' };
        mockEvent.rawQueryString = 'status=invalid_status';

        const rawResult = await handler(mockEvent, { dbClient: mockDynamoDbClientInstance, unmarshall: mockUnmarshall });
        const result = expectResultStructure(rawResult);

        expect(result.statusCode).toBe(400);
        expect(JSON.parse(result.body).message).toContain('Invalid status filter');
        expect(mockDynamoDbClientInstance.send).not.toHaveBeenCalled();
        expect(mockLoggerInstance.warn).toHaveBeenCalledWith({ statusFilter: 'invalid_status' }, expect.any(String));
    });

    it('should return 400 if nextToken is invalid base64', async () => {
        mockEvent.queryStringParameters = { nextToken: 'invalid-base64!!!' };
        mockEvent.rawQueryString = 'nextToken=invalid-base64!!!';

        const rawResult = await handler(mockEvent, { dbClient: mockDynamoDbClientInstance, unmarshall: mockUnmarshall });
        const result = expectResultStructure(rawResult);

        expect(result.statusCode).toBe(400);
        expect(JSON.parse(result.body).message).toBe('Invalid nextToken format.'); // Use exact message
        expect(mockDynamoDbClientInstance.send).not.toHaveBeenCalled();
        expect(mockLoggerInstance.warn).toHaveBeenCalledWith({ tokenSnippet: 'invalid-base64!!!' }, expect.any(String));
    });

    it('should return 400 if nextToken does not decode to valid JSON', async () => {
        const nonJsonToken = Buffer.from('not json').toString('base64');
        mockEvent.queryStringParameters = { nextToken: nonJsonToken };
        mockEvent.rawQueryString = `nextToken=${nonJsonToken}`;

        const rawResult = await handler(mockEvent, { dbClient: mockDynamoDbClientInstance, unmarshall: mockUnmarshall });
        const result = expectResultStructure(rawResult);

        expect(result.statusCode).toBe(400);
        expect(JSON.parse(result.body).message).toBe('Invalid nextToken format.'); // Use exact message
        expect(mockDynamoDbClientInstance.send).not.toHaveBeenCalled();
        expect(mockLoggerInstance.warn).toHaveBeenCalledWith({ tokenSnippet: nonJsonToken.substring(0, 50) }, expect.any(String));
    });

});
