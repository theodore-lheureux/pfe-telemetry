# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM rust:1.99.0-slim-trixie@sha256:0952c7a429d2f53c7f1f5e0796190690e7d8db367ec4a66ce0419763b9e5e0d0 AS build
RUN apt-get update && apt-get install --yes --no-install-recommends make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY apps/server/Cargo.toml apps/server/Cargo.toml
COPY apps/server/src apps/server/src
COPY apps/server/proto apps/server/proto
COPY apps/server/schema apps/server/schema
COPY apps/server/build.rs apps/server/build.rs
COPY apps/collector/Cargo.toml apps/collector/Cargo.toml
COPY apps/collector/src apps/collector/src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/workspace/target \
    cargo build --locked --release -p pfe-server --bins && cp target/release/pfe-server /pfe-server && cp target/release/pfe-storage /pfe-storage

FROM ghcr.io/grpc-ecosystem/grpc-health-probe:v0.4.57@sha256:f77f1257805ecb57f1f0c36c5825d3c2e47aa81cce87128675e768463ed6487a AS probe

FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a
COPY --from=build /pfe-server /usr/local/bin/pfe-server
COPY --from=build /pfe-storage /usr/local/bin/pfe-storage
RUN install -d -o 10001 -g 10001 -m 0700 /var/lib/pfe/measurements
COPY --from=probe /ko-app/grpc-health-probe /usr/local/bin/grpc_health_probe
ENV TELEMETRY_INGESTION_ADDR=0.0.0.0:4317
USER 10001:10001
EXPOSE 4317
ENTRYPOINT ["/usr/local/bin/pfe-server"]
