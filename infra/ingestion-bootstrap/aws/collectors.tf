variable "collectors_vpc_id" {
  description = "Existing Ohio VPC selected for collectors; no VPC creation permission is granted."
  type        = string
  default     = null
}

variable "collectors_enrollment_parameter_name" {
  type    = string
  default = "/recount/collectors/enrollment"
}

locals {
  collector_tags   = { project = "recount", component = "collectors" }
  collector_ec2    = "arn:aws:ec2:us-east-2:${var.expected_account_id}"
  collector_region = { StringEquals = { "aws:RequestedRegion" = "us-east-2" } }
  collector_owned = {
    StringEquals = {
      "aws:RequestedRegion"       = "us-east-2"
      "ec2:ResourceTag/project"   = "recount"
      "ec2:ResourceTag/component" = "collectors"
    }
  }
  collector_create = {
    StringEquals = {
      "aws:RequestedRegion"      = "us-east-2"
      "aws:RequestTag/project"   = "recount"
      "aws:RequestTag/component" = "collectors"
    }
  }
}

resource "aws_iam_user" "collectors_cd" {
  count         = var.collectors_vpc_id == null ? 0 : 1
  name          = "recount-collectors-cd"
  force_destroy = false
  tags          = local.collector_tags
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_role" "collector" {
  count = var.collectors_vpc_id == null ? 0 : 1
  name  = "recount-collector"
  tags  = local.collector_tags
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_instance_profile" "collector" {
  count = var.collectors_vpc_id == null ? 0 : 1
  name  = "recount-collector"
  role  = aws_iam_role.collector[0].name
  tags  = local.collector_tags
}

resource "aws_iam_role_policy" "enrollment" {
  count = var.collectors_vpc_id == null ? 0 : 1
  name  = "collector-enrollment-read"
  role  = aws_iam_role.collector[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = ["ssm:GetParameter"]
      Resource  = "arn:aws:ssm:us-east-2:${var.expected_account_id}:parameter${var.collectors_enrollment_parameter_name}"
      Condition = local.collector_region
    }]
  })
}

resource "aws_iam_policy" "collectors_cd" {
  count = var.collectors_vpc_id == null ? 0 : 1
  name  = "recount-collectors-region-tags-and-state"
  tags  = local.collector_tags
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "OwnStateListing", Effect = "Allow", Action = ["s3:ListBucket"]
        Resource  = "arn:aws:s3:::${var.state_bucket}"
        Condition = { StringEquals = { "s3:prefix" = ["aws/collectors/terraform.tfstate", "aws/collectors/workspaces/"] } }
      },
      {
        Sid      = "OwnState", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"]
        Resource = "arn:aws:s3:::${var.state_bucket}/aws/collectors/terraform.tfstate"
      },
      {
        Sid      = "OwnNativeLock", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "arn:aws:s3:::${var.state_bucket}/aws/collectors/terraform.tfstate.tflock"
      },
      {
        Sid = "OhioReadOnly", Effect = "Allow"
        Action = [
          "ec2:DescribeImages", "ec2:DescribeInstances", "ec2:DescribeInstanceAttribute",
          "ec2:DescribeInstanceCreditSpecifications", "ec2:DescribeInstanceTypes",
          "ec2:DescribeLaunchTemplates", "ec2:DescribeLaunchTemplateVersions",
          "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "ec2:DescribeSubnets",
          "ec2:DescribeVpcs", "ec2:DescribeNetworkInterfaces", "ec2:DescribeVolumes",
          "ec2:DescribeTags", "ec2:DescribeInstanceStatus", "ec2:DescribeAvailabilityZones"
        ]
        Resource = "*", Condition = local.collector_region
      },
      {
        Sid       = "CanonicalUbuntuOnly", Effect = "Allow", Action = ["ssm:GetParameter"]
        Resource  = "arn:aws:ssm:us-east-2::parameter/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
        Condition = local.collector_region
      },
      {
        Sid       = "PassOnlyCollectorRole", Effect = "Allow", Action = ["iam:PassRole"]
        Resource  = aws_iam_role.collector[0].arn
        Condition = { StringEquals = { "iam:PassedToService" = "ec2.amazonaws.com" } }
      },
      {
        Sid      = "ReadCollectorProfile", Effect = "Allow", Action = ["iam:GetInstanceProfile"]
        Resource = aws_iam_instance_profile.collector[0].arn
      },
      {
        Sid       = "LaunchCanonicalImage", Effect = "Allow", Action = ["ec2:RunInstances"]
        Resource  = "arn:aws:ec2:us-east-2::image/ami-*"
        Condition = { StringEquals = { "aws:RequestedRegion" = "us-east-2", "ec2:Owner" = "099720109477" } }
      },
      {
        Sid       = "LaunchInSelectedNetwork", Effect = "Allow", Action = ["ec2:RunInstances"]
        Resource  = ["${local.collector_ec2}:subnet/*"]
        Condition = { StringEquals = { "aws:RequestedRegion" = "us-east-2" }, ArnEquals = { "ec2:Vpc" = "${local.collector_ec2}:vpc/${var.collectors_vpc_id}" } }
      },
      {
        Sid      = "LaunchWithOwnedSecurityGroup", Effect = "Allow", Action = ["ec2:RunInstances"]
        Resource = "${local.collector_ec2}:security-group/*", Condition = local.collector_owned
      },
      {
        Sid      = "LaunchTaggedNano", Effect = "Allow", Action = ["ec2:RunInstances"]
        Resource = "${local.collector_ec2}:instance/*"
        Condition = { StringEquals = merge(local.collector_create.StringEquals, {
          "ec2:InstanceType" = "t4g.nano", "ec2:MetadataHttpTokens" = "required"
        }) }
      },
      {
        Sid       = "CreateTaggedLaunchInterfaces", Effect = "Allow", Action = ["ec2:RunInstances"]
        Resource  = "${local.collector_ec2}:network-interface/*"
        Condition = local.collector_create
      },
      {
        Sid      = "CreateSmallEncryptedGp3", Effect = "Allow", Action = ["ec2:RunInstances"]
        Resource = "${local.collector_ec2}:volume/*"
        Condition = {
          StringEquals          = merge(local.collector_create.StringEquals, { "ec2:VolumeType" = "gp3" })
          NumericLessThanEquals = { "ec2:VolumeSize" = "8" }
          Bool                  = { "ec2:Encrypted" = "true" }
        }
      },
      {
        Sid       = "CreateTaggedNetworkAndTemplate", Effect = "Allow", Action = ["ec2:CreateSecurityGroup", "ec2:CreateLaunchTemplate"]
        Resource  = ["${local.collector_ec2}:security-group/*", "${local.collector_ec2}:launch-template/*"]
        Condition = local.collector_create
      },
      {
        Sid      = "SecurityGroupInSelectedVpc", Effect = "Allow", Action = ["ec2:CreateSecurityGroup"]
        Resource = "${local.collector_ec2}:vpc/${var.collectors_vpc_id}", Condition = local.collector_region
      },
      {
        Sid      = "TagOnlyOnCreate", Effect = "Allow", Action = ["ec2:CreateTags"]
        Resource = ["${local.collector_ec2}:instance/*", "${local.collector_ec2}:volume/*", "${local.collector_ec2}:network-interface/*", "${local.collector_ec2}:security-group/*", "${local.collector_ec2}:launch-template/*"]
        Condition = {
          StringEquals               = local.collector_create.StringEquals
          "ForAnyValue:StringEquals" = { "ec2:CreateAction" = ["RunInstances", "CreateSecurityGroup", "CreateLaunchTemplate"] }
        }
      },
      {
        Sid = "ManageOnlyOwnedCollectors", Effect = "Allow"
        Action = [
          "ec2:TerminateInstances", "ec2:StopInstances", "ec2:StartInstances",
          "ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress",
          "ec2:RevokeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress",
          "ec2:RevokeSecurityGroupEgress", "ec2:CreateLaunchTemplateVersion",
          "ec2:ModifyLaunchTemplate", "ec2:DeleteLaunchTemplate", "ec2:DeleteLaunchTemplateVersions"
        ]
        Resource  = ["${local.collector_ec2}:instance/*", "${local.collector_ec2}:security-group/*", "${local.collector_ec2}:launch-template/*"]
        Condition = local.collector_owned
      }
    ]
  })
}

resource "aws_iam_user_policy_attachment" "collectors_cd" {
  count      = var.collectors_vpc_id == null ? 0 : 1
  user       = aws_iam_user.collectors_cd[0].name
  policy_arn = aws_iam_policy.collectors_cd[0].arn
}
