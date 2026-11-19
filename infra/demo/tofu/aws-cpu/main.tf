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

provider "aws" {
  region  = var.region
  profile = "recount-demo"
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}

data "aws_subnet" "demo" {
  id = var.subnet_id
}

data "aws_security_group" "demo" {
  id = var.security_group_id
}

resource "aws_instance" "collector" {
  count                                = var.collector_count
  ami                                  = data.aws_ami.ubuntu.id
  instance_type                        = "t4g.nano"
  subnet_id                            = data.aws_subnet.demo.id
  vpc_security_group_ids               = [data.aws_security_group.demo.id]
  associate_public_ip_address          = var.network_mode == "public"
  iam_instance_profile                 = var.instance_profile
  instance_initiated_shutdown_behavior = "terminate"
  credit_specification {
    cpu_credits = "standard"
  }
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }
  tags = {
    Name            = format("demo-%s-%03d", var.lab_id, count.index + 1)
    component       = "demo"
    recount-owner   = "recount-demo-semaphore"
    recount-lab     = var.lab_id
    recount-kind    = "cpu"
    recount-preset  = "t4g-nano"
    recount-ttl     = tostring(var.ttl_seconds)
    recount-expires = timeadd(var.created_at, "${var.ttl_seconds}s")
  }
  volume_tags = {
    component     = "demo"
    recount-owner = "recount-demo-semaphore"
    recount-lab   = var.lab_id
  }
  lifecycle {
    precondition {
      condition     = data.aws_subnet.demo.vpc_id == data.aws_security_group.demo.vpc_id && data.aws_subnet.demo.tags["component"] == "demo" && data.aws_security_group.demo.tags["component"] == "demo"
      error_message = "Use only the isolated demo subnet and security group."
    }
    precondition {
      condition     = var.expiry_guard_ready
      error_message = "Independent cloud expiry must be installed and verified before launching CPU VMs."
    }
  }
}

output "collectors" {
  value = [for instance in aws_instance.collector : {
    name        = instance.tags.Name
    instance_id = instance.id
    cloud       = "aws-cpu"
    kind        = "cpu"
    lab_id      = var.lab_id
    preset      = "t4g-nano"
    ttl_seconds = var.ttl_seconds
    region      = var.region
  }]
}
