terraform {
  required_version = "= 1.13.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.73.0"
    }
  }
  backend "s3" {}
}

provider "aws" { region = var.region }
data "aws_caller_identity" "current" {}

resource "aws_cloudwatch_log_group" "expiry" {
  name              = "/aws/lambda/recount-demo-expiry"
  retention_in_days = 7
}

resource "aws_iam_role" "expiry" {
  name = "recount-demo-expiry"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "expiry" {
  role = aws_iam_role.expiry.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ec2:DescribeInstances"], Resource = "*" },
      {
        Effect   = "Allow", Action = ["ec2:TerminateInstances"]
        Resource = "arn:aws:ec2:${var.region}:${data.aws_caller_identity.current.account_id}:instance/*"
        Condition = { StringEquals = {
          "ec2:ResourceTag/component"     = "demo"
          "ec2:ResourceTag/recount-owner" = "recount-demo-semaphore"
        } }
      },
      {
        Effect   = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.expiry.arn}:*"
      }
    ]
  })
}

resource "aws_lambda_function" "expiry" {
  function_name    = "recount-demo-expiry"
  role             = aws_iam_role.expiry.arn
  filename         = var.package_path
  source_code_hash = filebase64sha256(var.package_path)
  handler          = "handler.handler"
  runtime          = "python3.13"
  architectures    = ["arm64"]
  memory_size      = 128
  timeout          = 60
  environment {
    variables = {
      DEMO_VPC_ID            = var.vpc_id
      DEMO_SUBNET_ID         = var.subnet_id
      DEMO_SECURITY_GROUP_ID = var.security_group_id
      DEMO_INSTANCE_PROFILE  = var.instance_profile
    }
  }
  depends_on = [aws_cloudwatch_log_group.expiry, aws_iam_role_policy.expiry]
}

resource "aws_cloudwatch_event_rule" "expiry" {
  name                = "recount-demo-expiry"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "expiry" {
  rule = aws_cloudwatch_event_rule.expiry.name
  arn  = aws_lambda_function.expiry.arn
}

resource "aws_lambda_permission" "expiry" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.expiry.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.expiry.arn
}

variable "region" { type = string }
variable "vpc_id" { type = string }
variable "subnet_id" { type = string }
variable "security_group_id" { type = string }
variable "instance_profile" { type = string }
variable "package_path" { type = string }

output "lambda_arn" { value = aws_lambda_function.expiry.arn }
output "rule_arn" { value = aws_cloudwatch_event_rule.expiry.arn }
