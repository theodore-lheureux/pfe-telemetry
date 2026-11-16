resource "aws_s3_bucket" "transfer" {
  bucket = "recount-collector-transfer-${var.expected_account_id}"
  tags   = local.tags
}

resource "aws_s3_bucket_public_access_block" "transfer" {
  bucket                  = aws_s3_bucket.transfer.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "transfer" {
  bucket = aws_s3_bucket.transfer.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "transfer" {
  bucket = aws_s3_bucket.transfer.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_versioning" "transfer" {
  bucket = aws_s3_bucket.transfer.id
  versioning_configuration { status = "Disabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "transfer" {
  bucket = aws_s3_bucket.transfer.id
  rule {
    id     = "expire-interrupted-transfers"
    status = "Enabled"
    filter {}
    expiration { days = 1 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

resource "aws_s3_bucket_policy" "transfer" {
  bucket = aws_s3_bucket.transfer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TLSOnly", Effect = "Deny", Principal = "*", Action = "s3:*"
      Resource  = [aws_s3_bucket.transfer.arn, "${aws_s3_bucket.transfer.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

output "ansible_transfer_bucket" {
  value = aws_s3_bucket.transfer.id
}
