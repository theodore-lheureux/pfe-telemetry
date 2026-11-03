# Local telemetry pipeline

Run authenticated OTLP metrics ingestion, a single Kafka broker, one Rust storage worker and ClickHouse analytics. Existing Grafana monitoring and Vagrant VMs are managed separately by `just env`.

## Configure project credentials

Start the [application PostgreSQL service](../application/compose.yaml), configure the web application's `DATABASE_URL` and apply its Drizzle migrations with `bun run --cwd apps/web db:migrate`. The credential table must exist before provisioning ingestion access.

Choose a strong password for the dedicated lookup login, set it privately as `PFE_INGESTION_PASSWORD`, then run:

```sh
just app provision-ingestion
```

The [provisioning SQL](../application/ingestion-role.sql) grants `pfe_ingestion` database connection, `ingestion` schema usage and read-only access to `ingestion.collector_credential`. The login has no `app` schema access, schema/table ownership, schema creation, credential writes or role-management privileges. Re-running provisioning updates its password and resets its direct schema and table grants. Its four-connection limit is role-wide and supports one ingestion process with a four-connection pool; before adding replicas, provision separate restricted logins or explicitly budget the aggregate connection limit. Use this login only for ingestion, not for web requests or migrations. PostgreSQL [role grants](https://www.postgresql.org/docs/18/sql-grant.html) enforce access; read-only session defaults and query timeouts add defense in depth. `bash tests/ingestion-provisioning.sh` checks repeated provisioning, removal of excess direct grants, positive private-network lookup and denied unrelated reads/writes in a uniquely named disposable Compose cluster.

Copy `infra/telemetry/.env.example` to `infra/telemetry/.env` and replace the URL-encoded password. `TELEMETRY_INGESTION_DATABASE_URL` points to the same authoritative database used by the web application, through `credential-postgres:5432` on the private `pfe-credential-authority` Docker network. Start the application stack first: it owns this network; only PostgreSQL and ingestion join it. The host PostgreSQL port remains loopback-only for the web dev server. For isolated instances, use unique Compose project names and host ports, and set the same unique `PFE_CREDENTIAL_NETWORK_NAME` in both related stacks. This uses container service DNS, not host-gateway routing to a loopback port. The explicit `sslmode=disable` is for this local deployment only; remote databases require verified TLS. Do not use the web application's database-owner credentials.

As a verified project administrator, create a collector credential in the web application for each node, using its exact host ID (`pfe-compute-1` or `pfe-compute-2` for the VMs). Save each one-time token to the corresponding private file; do not generate replacement tokens with OpenSSL or maintain a static enrollment JSON file.

From the repository root:

```sh
mkdir -p infra/telemetry/.state
chmod 700 infra/telemetry/.state
# Save the one-time web-issued token in each file using a private editor.
touch infra/telemetry/.state/pfe-compute-1.token infra/telemetry/.state/pfe-compute-2.token
chmod 600 infra/telemetry/.state/*.token
```

Each credential's host allowlist must match `TELEMETRY_COLLECTOR_HOST_ID`. The server resolves project/source identity and policy from the web-managed credential row. Raw credentials remain in ignored `.state` files; ingestion stores no separate static enrollment authority.

```sh
just telemetry up
just telemetry status
```

The gRPC endpoint is `http://127.0.0.1:14317`; a Vagrant guest can reach it at `http://10.0.2.2:14317`. Port 14317 must be free. Override `TELEMETRY_INGESTION_PORT` in `infra/telemetry/.env` when needed.

Start the existing VMs with `just env vagrant up --no-provision`. Build a Linux collector for Docker's architecture and install it with:

```sh
just telemetry build-collector
just telemetry collectors
```

Docker and the VMs must use the same CPU architecture. Supply an alternate Linux binary with `just telemetry collectors /absolute/path/to/pfe-collector`. The Ansible playbook uses each VM's hostname as its enrolled host ID, installs its private token and starts `pfe-collector.service` without enabling boot startup. Collection runs as the Vagrant SSH user; unreadable process fields remain unavailable. `pfe_collector_state=stopped` stops it through the same playbook.

For another deployment, install the collector and its source token on each node. Set `TELEMETRY_COLLECTOR_SOURCE_TOKEN_FILE` to that node's private token file, `TELEMETRY_COLLECTOR_HOST_ID` to its enrolled host ID and `OTEL_EXPORTER_OTLP_ENDPOINT` to the ingestion endpoint. Use a separate queue directory for each destination and credential. The collector binds pending uploads to the destination and credential digest; changing either requires retaining the original queue for its original destination or starting a new queue.

Rotation, revocation and expiry take effect on the next authentication lookup without restarting ingestion. Follow the collector's [stop, drain, rotate and restart procedure](../../apps/collector/README.md#authenticated-ingestion). For the VMs, stop collection with `just telemetry collectors /absolute/path/to/pfe-collector --extra-vars pfe_collector_state=stopped`. On each VM, run the drain command as its collector user with the existing settings:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://10.0.2.2:14317 \
TELEMETRY_COLLECTOR_SOURCE_TOKEN_FILE=/etc/pfe-collector/source.token \
TELEMETRY_COLLECTOR_QUEUE_DIRECTORY=/var/lib/pfe-collector \
pfe-collector --drain
```

After draining, rotate in the web application and update the private `.state/<hostname>.token` files. Reinstall with a new systemd state-directory name, for example `just telemetry collectors /absolute/path/to/pfe-collector --extra-vars pfe_collector_queue_name=pfe-collector-rotated`. Continue using that name on later provisioning runs. The old queue remains bound to its old token even if empty. A rotated or revoked token cannot drain old pending uploads; queue migration is not implemented. `UNAUTHENTICATED` is a terminal OTLP rejection, while a database outage returns retryable `UNAVAILABLE`. Do not rotate credentials by reassigning them to a different project/source.

## Query measurements

Set three distinct private passwords in `infra/telemetry/.env`: `CLICKHOUSE_ADMIN_PASSWORD`, `CLICKHOUSE_WRITER_PASSWORD` and `CLICKHOUSE_READER_PASSWORD`. Compose initializes the current schema on an empty volume. For an existing current-schema volume, repeat schema provisioning explicitly:

```sh
just telemetry compose exec -T clickhouse sh -c 'clickhouse-client --user telemetry_admin --password "$CLICKHOUSE_PASSWORD" --multiquery' < infra/telemetry/clickhouse/schema.sql
```

The pinned image is supported ClickHouse 26.8 LTS. The administrator provisions the schema; the storage writer has SELECT/INSERT and the application reader SELECT only. Neither runtime login can create/drop/alter/truncate telemetry. Provisioning does not upgrade an incompatible existing schema: recreate disposable prototype state explicitly rather than silently reinterpreting it.

Configure `apps/web/.env` with `TELEMETRY_CLICKHOUSE_URL=http://127.0.0.1:18123` and `TELEMETRY_CLICKHOUSE_READER_PASSWORD` matching the reader password. Change `TELEMETRY_CLICKHOUSE_PORT` when the loopback port is occupied. The web application does not receive the writer or administrator password. See [recordings and query limits](../../docs/execution-telemetry.md).

Operator SQL is separate from tenant-authorized application queries. For duplicate-safe batch inspection:

```sh
just telemetry query "SELECT project_id, source_id, uniqExact(storage_key) AS logical_batches FROM telemetry.batches GROUP BY project_id, source_id LIMIT 20"
```

Raw `count()` over `batches` counts physical insert attempts, not logical observations. Point queries must select the earliest complete row per logical key before filtering, following the application query. There are no derived rate views or portable exports.

## Interrupt and resume processing

```sh
just telemetry compose stop storage
# Collectors can continue exporting while Kafka retains accepted batches.
just telemetry compose start storage
just telemetry compose logs --tail 20 storage
```

The worker commits an offset only after confirmed complete batch storage. If it dies after insertion but before that commit, replay recognizes the same key/digest, and queries suppress any physical duplicates. Temporary ClickHouse failure retries without advancing the offset. Consumer lag is available through the standard Kafka tool:

```sh
just telemetry compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9092 --describe --group pfe-storage
```

```sh
just telemetry stop
```

Stopping services keeps both named volumes. `docker compose down --volumes` deletes retained ingestion records and historical measurements; use it only for explicitly disposable state.

## Local limits

The broker uses one replica, six-hour retention and a 128 MiB per-partition retention target. Cleanup is asynchronous; active segments, metadata and internal topics use additional space. A single broker does not protect accepted data against loss of its disk. Kafka acknowledgements follow its replication and page-cache policy; this local setup does not promise survival of a host power failure. Collectors retain unacknowledged batches according to their own queue limits.

ClickHouse history and deduplication state have no automatic expiry. Logical source-history scans are resource-capped; sustained high-volume history needs a more selective coordinated acceptance index. The setup has one storage worker and one ClickHouse node, without disk-loss failover. Browser queries enforce project access; trace storage, distributed execution associations and production TLS remain separate work.
