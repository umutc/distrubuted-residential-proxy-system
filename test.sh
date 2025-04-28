# Retrieve the dummy key and export environment variables
export WS_ENDPOINT=wss://g0u8826061.execute-api.us-west-2.amazonaws.com/dev
export DUMMY_KEY=$(aws secretsmanager get-secret-value --secret-id distributed-res-proxy-agent-keys --query SecretString --output text | jq -r .dummy)
export AGENT_KEY=$DUMMY_KEY

# Run the script
node scripts/validate-ws.js
