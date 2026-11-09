group "default" {
  targets = ["collector", "ingestion-api", "normalizer", "web"]
}

target "collector" {
  context = "."
  dockerfile = "apps/collector/Dockerfile"
  tags = ["recount-collector:local"]
}

target "ingestion-api" {
  context = "."
  dockerfile = "apps/ingestion-api/Dockerfile"
  tags = ["recount-ingestion-api:local"]
}

target "normalizer" {
  context = "."
  dockerfile = "apps/normalizer/Dockerfile"
  tags = ["recount-normalizer:local"]
}

target "web" {
  context = "."
  dockerfile = "apps/web/Dockerfile"
  tags = ["recount-web:local"]
}
