terraform {
  required_version = ">= 1.12.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.71.0"
    }
  }
  backend "s3" {
    key                  = "aws/collectors/terraform.tfstate"
    encrypt              = true
    use_lockfile         = true
    workspace_key_prefix = "aws/collectors/workspaces"
  }
}

provider "aws" {
  region              = "us-east-2"
  allowed_account_ids = [var.expected_account_id]
  default_tags {
    tags = { project = "recount", component = "collectors" }
  }
}

data "aws_ssm_parameter" "ubuntu" {
  name            = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
  with_decryption = false
}

data "aws_ami" "ubuntu" {
  owners = ["099720109477"]
  filter {
    name   = "image-id"
    values = [nonsensitive(data.aws_ssm_parameter.ubuntu.value)]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
}

locals {
  tags = { project = "recount", component = "collectors" }
}

resource "aws_security_group" "collectors" {
  name        = "recount-collectors"
  description = "Collector egress; SSH only from explicitly selected operator networks"
  vpc_id      = var.vpc_id
  dynamic "ingress" {
    for_each = var.ssh_cidrs
    content {
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_launch_template" "collectors" {
  name                   = "recount-collectors"
  image_id               = data.aws_ami.ubuntu.id
  instance_type          = "t4g.nano"
  update_default_version = true
  iam_instance_profile {
    name = var.instance_profile_name
  }
  credit_specification {
    cpu_credits = "standard"
  }
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }
  block_device_mappings {
    device_name = data.aws_ami.ubuntu.root_device_name
    ebs {
      volume_size           = 8
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }
  network_interfaces {
    device_index                = 0
    associate_public_ip_address = true
    delete_on_termination       = true
    security_groups             = [aws_security_group.collectors.id]
  }
  dynamic "tag_specifications" {
    for_each = toset(["instance", "volume", "network-interface"])
    content {
      resource_type = tag_specifications.value
      tags          = local.tags
    }
  }
  user_data = base64encode("#cloud-config\n${yamlencode({
    package_update = true
    packages       = ["ca-certificates", "curl", "python3-boto3"]
    write_files = [
      {
        path        = "/etc/recount-collector/bootstrap.json"
        permissions = "0600"
        content = jsonencode({
          endpoint       = var.ingestion_endpoint
          enrollment_url = var.enrollment_url
          parameter      = var.enrollment_parameter_name
          release_url    = var.collector_release_url
          sha256         = var.collector_release_sha256
        })
      },
      {
        path        = "/usr/local/sbin/recount-collector-prepare"
        permissions = "0700"
        content     = file("${path.module}/prepare.py")
      },
      {
        path        = "/etc/systemd/system/recount-collector.service"
        permissions = "0644"
        content     = file("${path.module}/collector.service")
      },
      {
        path        = "/etc/recount-collector/runtime.env"
        permissions = "0600"
        content     = "OTEL_EXPORTER_OTLP_ENDPOINT=${var.ingestion_endpoint}\nRECOUNT_COLLECTOR_ENROLLMENT_URL=${var.enrollment_url}\n"
      }
    ]
    runcmd = [
      ["systemctl", "daemon-reload"],
      ["systemctl", "enable", "--now", "recount-collector.service"]
    ]
  })}")
  lifecycle {
    precondition {
      condition     = var.oracle_endpoint_verified
      error_message = "Do not create collectors until Oracle accepts an authorized point over HTTPS and exposes it through the analytical path."
    }
  }
}

resource "aws_instance" "collector" {
  for_each  = { first = var.subnet_ids[0], second = var.subnet_ids[1] }
  subnet_id = each.value
  launch_template {
    id      = aws_launch_template.collectors.id
    version = tostring(aws_launch_template.collectors.latest_version)
  }
  tags = { Name = "recount-collector-${each.key}" }
}

output "instances" {
  value = { for name, instance in aws_instance.collector : name => {
    id = instance.id, public_ip = instance.public_ip
  } }
}

output "estimated_monthly_usd" {
  description = "730 hours: EC2 plus 16 GiB gp3 plus two public IPv4s; excludes transfer, taxes and additional services."
  value       = 14.71
}
