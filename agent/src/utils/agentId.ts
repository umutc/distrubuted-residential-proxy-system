import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

let cachedAgentId: string | null = null;

// Define a persistent location for the agent ID
const configDir = path.join(os.homedir(), '.config', 'distributed-proxy-agent');
const agentIdFile = path.join(configDir, 'agent-id');

/**
 * Reads the agent ID from a persistent file or generates a new one.
 * Caches the ID in memory after the first read/generation.
 * @returns The unique agent ID string.
 */
function readOrGenerateAgentId(): string {
  try {
    // Ensure the config directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Try to read the existing ID
    if (fs.existsSync(agentIdFile)) {
      const id = fs.readFileSync(agentIdFile, 'utf8').trim();
      if (id) {
        return id;
      }
    }

    // Generate a new ID if file doesn't exist or is empty
    const newId = randomUUID();
    fs.writeFileSync(agentIdFile, newId, 'utf8');
    return newId;

  } catch (error) {
    console.error('Error reading/writing agent ID file:', error);
    // Fallback to generating a non-persistent ID in case of file system errors
    return randomUUID();
  }
}

/**
 * Retrieves the agent ID.
 * Uses a cached value after the first call.
 * @returns The agent ID string.
 */
export function getAgentId(): string {
  if (cachedAgentId === null) {
    cachedAgentId = readOrGenerateAgentId();
  }
  return cachedAgentId;
} 