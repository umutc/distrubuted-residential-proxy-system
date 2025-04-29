import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { register } from '../utils/metrics'; // Import the shared registry
import logger from '../utils/logger'; // Import the shared logger

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const log = logger.child({ handler: 'metrics' }); // Add handler context
    log.info('Metrics endpoint invoked');

    try {
        // IMPORTANT LIMITATION:
        // This currently returns metrics only from the specific Lambda instance 
        // handling this request. It does NOT represent aggregated metrics across 
        // all Orchestrator Lambda instances. 
        // Production solutions often use Prometheus Pushgateway, CloudWatch Exporter,
        // or aggregation via a shared store (Redis/DB).
        
        const metrics = await register.metrics();
        log.debug('Successfully retrieved metrics from local registry.');

        return {
            statusCode: 200,
            headers: {
                'Content-Type': register.contentType,
            },
            body: metrics,
        };
    } catch (error: any) {
        log.error({ errorCode: 'ORC-MET-1001', error: error.message, stack: error.stack }, 'Error retrieving or formatting metrics');
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ error: 'Failed to retrieve metrics', details: error.message }),
        };
    }
}; 