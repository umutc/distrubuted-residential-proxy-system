import pino from 'pino';

// Simple placeholder logger utility

// Basic Pino logger configuration optimized for Lambda/CloudWatch
const logger = pino({
    level: process.env.LOG_LEVEL || 'info', // Default to info, adjustable via ENV
    // Standard AWS Lambda fields can be mixed in automatically by Pino
    // if desired, but we'll keep it simple for now.
    // Use default JSON output (no pretty printing needed for CloudWatch)
});

export default logger; 