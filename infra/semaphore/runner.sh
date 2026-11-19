#!/bin/sh
set -eu
AWS_ACCESS_KEY_ID="$(jq -er '.AWS_ACCESS_KEY_ID' /run/demo/federation-aws.json)"
AWS_SECRET_ACCESS_KEY="$(jq -er '.AWS_SECRET_ACCESS_KEY' /run/demo/federation-aws.json)"
AWS_REGION="$(jq -er '.AWS_REGION' /run/demo/federation-aws.json)"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION
export AWS_CONFIG_FILE=/run/demo/aws-config
export AWS_EC2_METADATA_DISABLED=true
exec semaphore runner start --config /run/runner/config.json
