// Simple placeholder logger utility

export const logger = {
    debug: (message: string, ...optionalParams: any[]) => {
        console.debug(message, ...optionalParams);
    },
    info: (message: string, ...optionalParams: any[]) => {
        console.info(message, ...optionalParams);
    },
    warn: (message: string, ...optionalParams: any[]) => {
        console.warn(message, ...optionalParams);
    },
    error: (message: string, ...optionalParams: any[]) => {
        console.error(message, ...optionalParams);
    },
}; 