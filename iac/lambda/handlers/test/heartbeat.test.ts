import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { DynamoDBClient, UpdateItemCommand, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { handler } from '../heartbeat';
import { APIGatewayProxyWebsocketEventV2, APIGatewayEventWebsocketRequestContextV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import ActualLogger from '../../utils/logger'; // Import actual logger type

// --- Mocks ---
const mockLogger = {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
};
vi.mock('../../utils/logger', () => ({ 
    default: mockLogger
}));

vi.mock('@aws-sdk/client-dynamodb');

const mockDynamoDbClient = mockDeep<DynamoDBClient>();
const MockUpdateItemCommand = vi.fn();

vi.mocked(DynamoDBClient).mockImplementation(() => mockDynamoDbClient);
vi.mocked(UpdateItemCommand).mockImplementation((...args) => new MockUpdateItemCommand(...args) as any);


// --- Tests ---
describe('Heartbeat Handler', () => {
    const MOCK_CONNECTION_ID = 'test-connection-id';
    const MOCK_TABLE_NAME = 'mock-agent-registry';
    let mockEvent: APIGatewayProxyWebsocketEventV2;

    beforeAll(() => {
        process.env.AGENT_REGISTRY_TABLE_NAME = MOCK_TABLE_NAME;
    });

    beforeEach(() => {
        vi.clearAllMocks();
        MockUpdateItemCommand.mockClear();
        mockDynamoDbClient.send.mockResolvedValue({} as any);

        const mockRequestContext: Partial<APIGatewayEventWebsocketRequestContextV2> = {
            apiId: 'test-api-id',
            connectionId: MOCK_CONNECTION_ID,
            domainName: 'test.domain.com',
            stage: 'dev',
            eventType: 'MESSAGE',
            extendedRequestId: 'test-ext-req-id',
            identity: { // Cast to any to bypass strict type checking for identity
                sourceIp: '127.0.0.1',
            } as any,
            messageDirection: 'IN',
            messageId: 'test-msg-id',
            requestTime: new Date().toISOString(),
            requestTimeEpoch: Date.now(),
            requestId: 'test-req-id',
            routeKey: 'heartbeat',
            connectedAt: Date.now() - 10000,
        };

        mockEvent = {
            requestContext: mockRequestContext as APIGatewayEventWebsocketRequestContextV2, // Cast back
            headers: {}, // Headers are valid, cast event to any if linter complains
            isBase64Encoded: false,
            body: JSON.stringify({ action: 'heartbeat' }),
        } as any; // Cast the whole event to any to bypass header check if needed
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
        const rawResult = await handler(mockEvent);
        const result = expectResultStructure(rawResult);

        expect(result.statusCode).toBe(200);
        expect(result.body).toBe('Heartbeat acknowledged.');
        expect(DynamoDBClient).toHaveBeenCalledTimes(1);
        expect(MockUpdateItemCommand).toHaveBeenCalledTimes(1);
        const commandArgs = MockUpdateItemCommand.mock.calls[0][0];
        expect(commandArgs.TableName).toBe(MOCK_TABLE_NAME);
        expect(commandArgs.Key.connectionId.S).toBe(MOCK_CONNECTION_ID);
        expect(commandArgs.UpdateExpression).toContain('lastHeartbeat = :ts');
        expect(commandArgs.UpdateExpression).toContain('#ttl = :ttlValue');
        expect(commandArgs.UpdateExpression).toContain('#status = :statusValue');
        expect(commandArgs.ExpressionAttributeValues[':statusValue'].S).toBe('active');
        expect(commandArgs.ConditionExpression).toBe('attribute_exists(connectionId)');
        expect(mockDynamoDbClient.send).toHaveBeenCalledTimes(1);
        expect(mockLogger.info).toHaveBeenCalledWith('Successfully updated agent heartbeat and TTL');
    });

    it('should return 200 and log error if table name is not set', async () => {
        const originalTableName = process.env.AGENT_REGISTRY_TABLE_NAME;
        delete process.env.AGENT_REGISTRY_TABLE_NAME;

        const rawResult = await handler(mockEvent);
        const result = expectResultStructure(rawResult);

        process.env.AGENT_REGISTRY_TABLE_NAME = originalTableName;

        expect(result.statusCode).toBe(200);
        expect(result.body).toBe('Heartbeat processed (internal error).');
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'ORC-CFG-1001' }), expect.any(String));
        expect(mockDynamoDbClient.send).not.toHaveBeenCalled();
    });

    it('should return 200 and log warning on ConditionalCheckFailedException', async () => {
        const conditionalError = new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} });
        mockDynamoDbClient.send.mockRejectedValueOnce(conditionalError);

        const rawResult = await handler(mockEvent);
        const result = expectResultStructure(rawResult);

        expect(result.statusCode).toBe(200);
        expect(result.body).toBe('Heartbeat processed (internal error).');
        expect(mockDynamoDbClient.send).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'ORC-APP-1001' }), expect.any(String));
        expect(mockLogger.error).not.toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'ORC-DEP-1003' }), expect.anything());
    });

    it('should return 200 and log error on generic DynamoDB failure', async () => {
        const genericError = new Error('DynamoDB blew up');
        mockDynamoDbClient.send.mockRejectedValueOnce(genericError);

        const rawResult = await handler(mockEvent);
        const result = expectResultStructure(rawResult);

        expect(result.statusCode).toBe(200);
        expect(result.body).toBe('Heartbeat processed (internal error).');
        expect(mockDynamoDbClient.send).toHaveBeenCalledTimes(1);
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'ORC-DEP-1003' }), expect.any(String));
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });
}); 