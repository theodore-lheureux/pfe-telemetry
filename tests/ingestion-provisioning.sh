#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
web=${PFE_TEST_WEB_DIRECTORY:-"$root/apps/web"}
project="pfe-credential-smoke-$(openssl rand -hex 8)"
export PFE_CREDENTIAL_NETWORK_NAME="$project"
export POSTGRES_PASSWORD=pfe-provisioning-test-only
export PFE_INGESTION_PASSWORD=pfe-reader-test-only
export POSTGRES_PORT=0
image=postgres:18.6-trixie@sha256:3a4264520e121176619f54ff867d12774bc81e95e7b84db58d63bccdb6144b81
compose=(docker compose --project-name "$project" --env-file /dev/null --file "$root/infra/application/compose.yaml")
cleanup() {
    "${compose[@]}" down --volumes >/dev/null
}
trap cleanup EXIT
"${compose[@]}" up --detach --wait --wait-timeout 90
container=$("${compose[@]}" ps --quiet postgres)
port=$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$container")
[[ "$port" =~ ^[0-9]+$ && "$port" -gt 0 ]]
DATABASE_URL="postgresql://pfe:$POSTGRES_PASSWORD@127.0.0.1:$port/pfe" bun --no-env-file "$web/scripts/migrate.ts"
for attempt in 1 2; do
    if [[ $attempt == 2 ]]; then
        "${compose[@]}" exec -T postgres psql --username=pfe --dbname=pfe --set=ON_ERROR_STOP=1 --command="GRANT USAGE ON SCHEMA app TO pfe_ingestion; GRANT SELECT ON ALL TABLES IN SCHEMA app TO pfe_ingestion; GRANT CREATE ON SCHEMA ingestion TO pfe_ingestion;"
    fi
    "${compose[@]}" exec -T --env PFE_INGESTION_PASSWORD postgres psql --username=pfe --dbname=pfe < "$root/infra/application/ingestion-role.sql"
done
"${compose[@]}" exec -T postgres psql --username=pfe --dbname=pfe --set=ON_ERROR_STOP=1 <<'SQL'
INSERT INTO app.organization (id,name,slug,created_at) VALUES ('test-org','Test','test',now());
INSERT INTO app.project (id,organization_id,name,slug) VALUES ('019a4790-d1da-7000-8000-000000000002','test-org','Test','test');
INSERT INTO ingestion.collector_credential (id,organization_id,project_id,source_id,name,token_sha256,hosts)
VALUES ('019a4790-d1da-7000-8000-000000000001','test-org','019a4790-d1da-7000-8000-000000000002','source','Test',repeat('a',64),ARRAY['node1']);
SQL
reader() {
    docker run --rm --network "$PFE_CREDENTIAL_NETWORK_NAME" --env PGPASSWORD="$PFE_INGESTION_PASSWORD" "$image" \
        psql --host=credential-postgres --username=pfe_ingestion --dbname=pfe --set=ON_ERROR_STOP=1 --tuples-only --no-align "$@"
}
[[ $(reader --command="SELECT project_id FROM ingestion.collector_credential WHERE id='019a4790-d1da-7000-8000-000000000001' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > statement_timestamp())") == 019a4790-d1da-7000-8000-000000000002 ]]
[[ $(reader --command="SELECT has_schema_privilege(current_user, 'app', 'USAGE')") == f ]]
[[ $(reader --command="SELECT has_schema_privilege(current_user, 'ingestion', 'CREATE')") == f ]]
for sql in 'SELECT * FROM app.user' 'SELECT * FROM app.session' 'SELECT * FROM app.project' "INSERT INTO ingestion.collector_credential SELECT * FROM ingestion.collector_credential" "UPDATE ingestion.collector_credential SET name='denied'" 'DELETE FROM ingestion.collector_credential' 'CREATE TABLE ingestion.denied (id integer)'; do
    if result=$(reader --set=VERBOSITY=sqlstate --command="SET default_transaction_read_only=off" --command="$sql" 2>&1); then
        echo 'Ingestion role exceeded its privileges' >&2
        exit 1
    fi
    if [[ "$result" != *42501* ]]; then
        echo 'Expected a PostgreSQL insufficient_privilege denial' >&2
        exit 1
    fi
done
echo 'Shipped provisioning is repeatable; private-network lookup succeeds and unrelated reads/writes are denied.'
