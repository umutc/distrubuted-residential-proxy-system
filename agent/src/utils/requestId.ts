import { randomUUID } from 'crypto';

/**
 * Generates a unique request ID.
 * Currently uses crypto.randomUUID().
 * @param baseId Optional base ID to incorporate (currently unused).
 * @returns A unique string identifier.
 */
export function generateRequestId(baseId?: string): string {
  // baseId is currently unused but kept for potential future use
  // like prefixing or linking requests.
  return randomUUID();
} 