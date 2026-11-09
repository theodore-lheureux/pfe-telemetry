# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM ghcr.io/grpc-ecosystem/grpc-health-probe:v0.4.57@sha256:f77f1257805ecb57f1f0c36c5825d3c2e47aa81cce87128675e768463ed6487a AS probe
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a
ARG TARGETARCH
ARG RECOUNT_ARTIFACT_DIR=.state/artifacts/${TARGETARCH}
COPY --chmod=0555 ${RECOUNT_ARTIFACT_DIR}/bin/recount-ingestion-api /usr/local/bin/recount-ingestion-api
COPY --from=probe /ko-app/grpc-health-probe /usr/local/bin/grpc_health_probe
ENV RECOUNT_INGESTION_ADDR=0.0.0.0:4317
USER 10001:10001
EXPOSE 4317
ENTRYPOINT ["/usr/local/bin/recount-ingestion-api"]
