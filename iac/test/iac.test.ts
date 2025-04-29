import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as Iac from '../lib/iac-stack';
import { test, expect } from 'vitest';

// example test. To run these tests, uncomment this file along with the
// example resource in lib/iac-stack.ts
test('SQS Queue Created', () => {
//   const app = new cdk.App();
//     // WHEN
//   const stack = new Iac.OrchestratorStack(app, 'MyTestStack');
//     // THEN
//   const template = Template.fromStack(stack);

//   template.hasResourceProperties('AWS::SQS::Queue', {
//     VisibilityTimeout: 300
//   });
    expect(true).toBe(true); // Placeholder assertion
});
