# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a
ARG TARGETARCH
ARG RECOUNT_ARTIFACT_DIR=.state/artifacts/${TARGETARCH}
COPY --chmod=0555 ${RECOUNT_ARTIFACT_DIR}/bin/recount-normalizer /usr/local/bin/recount-normalizer
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/recount-normalizer"]
