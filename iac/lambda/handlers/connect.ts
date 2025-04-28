import { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

const secretsManager = new SecretsManagerClient({});
const dynamo = new DynamoDBClient({});
let cachedAgentKeys: Record<string, string> | null = null;
let lastFetch = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute
const SECRET_ID = process.env.AGENT_API_KEYS_SECRET_ARN || 'distributed-res-proxy-agent-keys';
const AGENT_REGISTRY_TABLE = process.env.AGENT_REGISTRY_TABLE || 'distributed-res-proxy-agent-registry';

async function getAgentKeys(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedAgentKeys && now - lastFetch < CACHE_TTL_MS) {
    return cachedAgentKeys;
  }
  const resp = await secretsManager.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  if (!resp.SecretString) throw new Error('No secret string found');
  const keys = JSON.parse(resp.SecretString);
  cachedAgentKeys = keys;
  lastFetch = now;
  return keys;
}

function getAgentKeyFromEvent(event: APIGatewayProxyWebsocketEventV2): string | undefined {
  // Try query string first
  const qs = (event as any).queryStringParameters;
  if (qs && qs.AGENT_KEY) {
    return qs.AGENT_KEY;
  }
  // Try headers
  const headers = (event as any).headers;
  if (headers && headers['AGENT_KEY']) {
    return headers['AGENT_KEY'];
  }
  return undefined;
}

export const handler = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
  console.log('Connect Event:', JSON.stringify(event, null, 2));
  const connectionId = event.requestContext.connectionId;
  const agentKey = getAgentKeyFromEvent(event);
  if (!agentKey) {
    console.warn(`No AGENT_KEY provided for connection: ${connectionId}`);
    return { statusCode: 401, body: 'Missing AGENT_KEY' };
  }
  let agentKeys;
  try {
    agentKeys = await getAgentKeys();
  } catch (err) {
    console.error('Failed to fetch agent keys:', err);
    return { statusCode: 500, body: 'Internal error' };
  }
  const valid = Object.values(agentKeys).includes(agentKey);
  if (!valid) {
    console.warn(`Invalid AGENT_KEY for connection: ${connectionId}`);
    return { statusCode: 401, body: 'Invalid AGENT_KEY' };
  }
  // TODO: Register agent in registry (Task 2.2)
  try {
    await dynamo.send(new PutItemCommand({
      TableName: AGENT_REGISTRY_TABLE,
      Item: {
        connectionId: { S: connectionId },
        status: { S: 'available' },
        connectedAt: { S: new Date().toISOString() },
        // Optionally add agentId, etc.
      },
    }));
    console.log(`Registered agent connection: ${connectionId}`);
  } catch (err) {
    console.error('Failed to register agent:', err);
    return { statusCode: 500, body: 'Failed to register agent' };
  }
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Connected.' }),
  };
}; 