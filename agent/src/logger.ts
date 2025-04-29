import pino from 'pino';

// Basic Pino logger configuration
const logger = pino({
    level: process.env.LOG_LEVEL || 'info', // Default to info, adjustable via ENV
    transport: {
        target: 'pino-pretty', // Use pino-pretty for development (requires separate install: npm i -D pino-pretty)
        options: {
            colorize: true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l', // Consistent timestamp format
            ignore: 'pid,hostname', // Optional: Hide pid/hostname for cleaner logs
        }
    },
});

// // Alternative basic config without pino-pretty (outputs JSON):
// const logger = pino({
//     level: process.env.LOG_LEVEL || 'info',
// });

export default logger; 