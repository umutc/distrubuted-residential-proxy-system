import { APIGateway } from 'aws-sdk';
import { CloudFormationCustomResourceEvent, Context } from 'aws-lambda';

// Lambda handler to set the API Gateway account CloudWatch Logs role
exports.handler = async function(event: CloudFormationCustomResourceEvent, context: Context) {
  const apigw = new APIGateway();
  const roleArn = event.ResourceProperties.RoleArn;

  if (!roleArn) {
    throw new Error('RoleArn property is required');
  }

  try {
    await apigw.updateAccount({
      patchOperations: [
        {
          op: 'replace',
          path: '/cloudwatchRoleArn',
          value: roleArn,
        },
      ],
    }).promise();
    return {
      PhysicalResourceId: 'ApiGatewayAccountCloudWatchLogsRole',
      Status: 'SUCCESS',
    };
  } catch (error) {
    console.error('Failed to set API Gateway CloudWatch Logs role:', error);
    throw error;
  }
}; 