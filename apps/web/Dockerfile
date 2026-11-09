# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
ARG TARGETARCH
ARG RECOUNT_ARTIFACT_DIR=.state/artifacts/${TARGETARCH}
WORKDIR /app
COPY --chown=bun:bun ${RECOUNT_ARTIFACT_DIR}/web/ ./
ENV NODE_ENV=production
ENV NITRO_HOST=0.0.0.0 NITRO_PORT=3000
USER bun
EXPOSE 3000
CMD ["bun", "server/index.mjs"]
