#!/usr/bin/env bash
set -euo pipefail

arch=${1:?target architecture required}
release=${2:?release identifier required}
[[ $release =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]]
case "$arch:$(uname -m)" in
    amd64:x86_64|arm64:aarch64) ;;
    *) echo 'Release packaging requires a matching native Linux builder' >&2; exit 1 ;;
esac
[[ $(uname -s) == Linux ]]
bundle=".state/release/$arch"
mkdir -p "$bundle"
mkdir "$bundle/backend"
mkdir "$bundle/backend/infra"
mkdir "$bundle/backend/infra/local"
cp infra/local/compose.yaml infra/local/data-entrypoint.sh infra/local/data.ts "$bundle/backend/infra/local/"
mkdir "$bundle/backend/infra/clickhouse" "$bundle/backend/infra/kafka"
for file in Dockerfile entrypoint.sh verify-schema.sh healthcheck.sh users.xml config.xml; do
    cp "infra/clickhouse/$file" "$bundle/backend/infra/clickhouse/"
done
cp infra/kafka/init-topics.sh "$bundle/backend/infra/kafka/"
mkdir -p "$bundle/backend/infra/oracle-stack/deploy"
cp infra/oracle-stack/deploy/clickhouse-memory.xml "$bundle/backend/infra/oracle-stack/deploy/"
cp infra/local/data.binds.yaml "$bundle/backend/infra/local/"
cp -R .state/release-schema "$bundle/backend/schema"
cp infra/local/compose.apps.yaml "$bundle/"
cp infra/oracle-stack/deploy/compose.yaml "$bundle/compose.release.yaml"
cp infra/oracle-stack/deploy/activate.sh "$bundle/"
cp infra/oracle-stack/deploy/check-storage.sh "$bundle/"
printf '%s\n' "$release" > "$bundle/release"
printf '%s\n' "$arch" > "$bundle/arch"
for service in ingestion-api normalizer web; do
    docker tag "recount-$service:local" "recount-$service:$release"
done
cat > "$bundle/images.env" <<EOF
RECOUNT_INGESTION_IMAGE=recount-ingestion-api:$release
RECOUNT_NORMALIZER_IMAGE=recount-normalizer:$release
RECOUNT_WEB_IMAGE=recount-web:$release
EOF
docker image save "recount-ingestion-api:$release" "recount-normalizer:$release" \
    "recount-web:$release" "recount-clickhouse:$release" | gzip > "$bundle/images.tar.gz"
image_bytes=$(docker image inspect --format '{{.Size}}' "recount-ingestion-api:$release" \
    "recount-normalizer:$release" "recount-web:$release" "recount-clickhouse:$release" |
    awk '{ total += $1 } END { printf "%.0f", total }')
[[ $image_bytes -le 4294967296 ]] || { echo 'Release images exceed the 4 GiB unpacked budget' >&2; exit 1; }
(
    cd "$bundle/backend"
    find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > ../backend.SHA256SUMS
)
find apps/web/drizzle -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1 > "$bundle/migrations.sha256"
tar -czf ".state/recount-stack-$arch.tar.gz" -C "$bundle" .
[[ $(stat -c %s ".state/recount-stack-$arch.tar.gz") -le 2147483648 ]] || {
    echo 'Release exceeds the 2 GiB download budget' >&2; exit 1;
}
(
    cd .state
    sha256sum "recount-stack-$arch.tar.gz" > "recount-stack-$arch.tar.gz.sha256"
)
