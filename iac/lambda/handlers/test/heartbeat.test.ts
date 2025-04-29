import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { DynamoDBClient, UpdateItemCommand, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { APIGatewayProxyWebsocketEventV2, APIGatewayEventWebsocketRequestContextV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import ActualLogger from '../../utils/logger'; // Keep type import

// --- Define Mock Variables (used in doMock factories) ---
const mockLoggerInstance = {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
};
const mockDynamoDbClientInstance = mockDeep<DynamoDBClient>();
const MockUpdateItemCommandInstance = vi.fn(); // Mock for constructor

// --- Test Suite ---
describe('Heartbeat Handler', () => {
    const MOCK_CONNECTION_ID = 'test-connection-id';
    const MOCK_TABLE_NAME = 'mock-agent-registry';
    let mockEvent: APIGatewayProxyWebsocketEventV2;
    let handler: typeof import('../heartbeat').handler;

    beforeAll(async () => {
        // Set Env Var FIRST
        process.env.AGENT_REGISTRY_TABLE_NAME = MOCK_TABLE_NAME;

        // Apply mocks dynamically
        vi.doMock('../../utils/logger', () => ({ default: mockLoggerInstance }));

        // Mock only Command constructors and Exceptions, not the client itself
        vi.doMock('@aws-sdk/client-dynamodb', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
            return {
                ...actual,
                DynamoDBClient: actual.DynamoDBClient, // Use actual client class
                UpdateItemCommand: MockUpdateItemCommandInstance,
                ConditionalCheckFailedException: actual.ConditionalCheckFailedException, // Use actual exception
            };
        });

        // Import handler *after* mocks and setting env var
        const module = await import('../heartbeat');
        handler = module.handler;
    });

    afterAll(() => {
        // Unmock all dynamically mocked modules
        vi.doUnmock('../../utils/logger');
        vi.doUnmock('@aws-sdk/client-dynamodb');
    });

    beforeEach(() => {
        // Ensure table name is set correctly before each test 
        process.env.AGENT_REGISTRY_TABLE_NAME = MOCK_TABLE_NAME;
        // Clear mocks
        vi.clearAllMocks();
        mockDynamoDbClientInstance.send.mockReset();
        // Command constructor mock cleared by vi.clearAllMocks()
        // Logger mock cleared by vi.clearAllMocks()

        // Default mock event setup
        const mockRequestContext: Partial<APIGatewayEventWebsocketRequestContextV2> = {
            apiId: 'test-api-id',
            connectionId: MOCK_CONNECTION_ID,
            domainName: 'test.domain.com',
            stage: 'dev',
            eventType: 'MESSAGE',
            extendedRequestId: 'test-ext-req-id',
            messageDirection: 'IN',
            messageId: 'test-msg-id',
            requestTime: new Date().toISOString(),
            requestTimeEpoch: Date.now(),
            requestId: 'test-req-id',
            routeKey: 'heartbeat',
            connectedAt: Date.now() - 10000,
        };

        mockEvent = {
            requestContext: mockRequestContext as APIGatewayEventWebsocketRequestContextV2,
            headers: {},
            isBase64Encoded: false,
            body: JSON.stringify({ action: 'heartbeat' }),
        } as any;
    });

    // Helper to assert result structure
    const expectResultStructure = (result: APIGatewayProxyResultV2 | string | void | null | undefined) => {
        expect(result).toBeDefined();
        expect(typeof result).toBe('object');
        expect(result).toHaveProperty('statusCode');
        expect(result).toHaveProperty('body');
        return result as { statusCode: number; body: string };
    }

    it('should update agent heartbeat and TTL successfully', async () => {
        mockDynamoDbClientInstance.send.mockResolvedValue({} as any); // Mock successful send

        // Inject mock client
        const rawResult = await handler(mockEvent, { dbClient: mockDynamoDbClientInstance });
        const result = expectResultStructure(rawResult);

        expect(result.statusCode).toBe(200);
        expect(result.body).toBe('Heartbeat acknowledged.');
        expect(mockDynamoDbClientInstance.send).toHaveBeenCalledTimes(1);
        expect(MockUpdateItemCommandInstance).toHaveBeenCalledTimes(1);
        const commandArgs = MockUpdateItemCommandInstance.mock.calls[0][0];
        expect(commandArgs.TableName).toBe(MOCK_TABLE_NAME);
        expect(commandArgs.Key.connectionId.S).toBe(MOCK_CONNECTION_ID);
        expect(commandArgs.UpdateExpression).toContain('lastHeartbeat = :ts');
        expect(commandArgs.UpdateExpression).toContain('#ttl = :ttlValue');
        expect(commandArgs.UpdateExpression).toContain('#status = :statusValue');
        expect(commandArgs.ExpressionAttributeValues[':statusValue'].S).toBe('active');
        expect(commandArgs.ConditionExpression).toBe('attribute_exists(connectionId)');
        expect(mockLoggerInstance.info).toHaveBeenCalledWith('Successfully updated agent heartbeat and TTL');
    });

    it('should return 200 and log error if table name is not set', async () => {
        const originalTableName = process.env.AGENT_REGISTRY_TABLE_NAME;
        delete process.env.AGENT_REGISTRY_TABLE_NAME;

        // Dynamically import handler for this specific test case
        vi.resetModules();
        vi.doMock('../../utils/logger', () => ({ default: mockLoggerInstance }));
        vi.doMock('@aws-sdk/client-dynamodb', async (importOriginal) => { 
            const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>(); 
            return { 
                ...actual, 
                UpdateItemCommand: MockUpdateItemCommandInstance, 
                ConditionalCheckFailedException: actual.ConditionalCheckFailedException
            }; 
        });
        const { handler: localHandler } = await import('../heartbeat');

        const rawResult = await localHandler(mockEvent, { dbClient: mockDynamoDbClientInstance });
        const result = expectResultStructure(rawResult);

        // Restore and cleanup
        process.env.AGENT_REGISTRY_TABLE_NAME = originalTableName;
        vi.doUnmock('../../utils/logger');
        vi.doUnmock('@aws-sdk/client-dynamodb');
        vi.resetModules();

        expect(result.statusCode).toBe(200);
        expect(result.body).toBe('Heartbeat processed (internal error).');
        expect(mockLoggerInstance.error).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'ORC-CFG-1001' }), 'AGENT_REGISTRY_TABLE_NAME environment variable not set.');
        expect(mockDynamoDbClientInstance.send).not.toHaveBeenCalled();
    });

    it('should return 200 and log warning on ConditionalCheckFailedException', async () => {
        const conditionalError = new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} });
        mockDynamoDbClientInstance.send.mockRejectedValueOnce(conditionalError);

        const rawResult = await handler(mockEvent, { dbClient: mockDynamoDbClientInstance });
        const result = expectResultStructure(rawResult);

        expect(result.statusCode).toBe(200);
        expect(result.body).toBe('Heartbeat processed (internal error).');
        expect(mockDynamoDbClientInstance.send).toHaveBeenCalledTimes(1);
        expect(MockUpdateItemCommandInstance).toHaveBeenCalledTimes(1);
        expect(mockLoggerInstance.warn).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'ORC-APP-1001' }), 'Heartbeat received for unknown or disconnected connectionId.');
        expect(mockLoggerInstance.error).not.toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'ORC-DEP-1003' }), expect.anything());
    });

    it('should return 200 and log error on generic DynamoDB failure', async () => {
        const genericError = new Error('DynamoDB blew up');
        mockDynamoDbClientInstance.send.mockRejectedValueOnce(genericError);

        const rawResult = await handler(mockEvent, { dbClient: mockDynamoDbClientInstance });
        const result = expectResultStructure(rawResult);

        expect(result.statusCode).toBe(200);
        expect(result.body).toBe('Heartbeat processed (internal error).');
        expect(mockDynamoDbClientInstance.send).toHaveBeenCalledTimes(1);
        expect(MockUpdateItemCommandInstance).toHaveBeenCalledTimes(1);
        expect(mockLoggerInstance.error).toHaveBeenCalledWith(
            expect.objectContaining({ 
                errorCode: 'ORC-DEP-1003', 
                error: genericError.message, 
                stack: expect.any(String) 
            }), 
            'Error updating agent heartbeat in Agent Registry'
        );
        expect(mockLoggerInstance.warn).not.toHaveBeenCalled();
    });
}); 