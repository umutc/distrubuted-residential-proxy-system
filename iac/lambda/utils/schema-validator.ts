import Ajv, { JSONSchemaType } from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

// Define schemas for different message types
const schemas: Record<string, object> = {
  ping: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { const: 'ping' },
      requestId: { type: 'string' },
      data: { type: 'object', nullable: true }
    },
    additionalProperties: true
  },
  register: {
    type: 'object',
    required: ['action', 'data'],
    properties: {
      action: { const: 'register' },
      requestId: { type: 'string' },
      data: {
        type: 'object',
        required: ['agentId', 'capabilities'],
        properties: {
          agentId: { type: 'string' },
          capabilities: {
            type: 'array',
            items: { type: 'string' }
          },
          metadata: { type: 'object', nullable: true }
        },
        additionalProperties: true
      }
    },
    additionalProperties: true
  },
  job_response: {
    type: 'object',
    required: ['action', 'data'],
    properties: {
      action: { const: 'job_response' },
      requestId: { type: 'string' },
      data: {
        type: 'object',
        required: ['jobId', 'status'],
        properties: {
          jobId: { type: 'string' },
          status: { enum: ['success', 'failure', 'in_progress'] },
          result: { type: 'object', nullable: true },
          error: { type: 'string', nullable: true }
        },
        additionalProperties: true
      }
    },
    additionalProperties: true
  }
};

// Compile validators
const validators: Record<string, ReturnType<typeof ajv.compile>> = {};
for (const [key, schema] of Object.entries(schemas)) {
  validators[key] = ajv.compile(schema);
}

export function validateMessage(message: any): { valid: boolean; errors: any[] } {
  if (!message || typeof message !== 'object' || !message.action) {
    return { valid: false, errors: [{ message: 'Invalid message format or missing action' }] };
  }
  const validator = validators[message.action];
  if (!validator) {
    return { valid: false, errors: [{ message: `Unknown action: ${message.action}` }] };
  }
  const valid = Boolean(validator(message));
  return {
    valid,
    errors: valid ? [] : validator.errors || []
  };
} 