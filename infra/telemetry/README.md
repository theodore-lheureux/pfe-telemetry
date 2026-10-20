# Local telemetry pipeline

Run authenticated OTLP metrics ingestion, a single Kafka broker, one Rust storage worker and DuckDB queries against published Parquet files. Existing Grafana monitoring and Vagrant VMs are managed separately by `just env`.

## Configure source access

From the repository root:

```sh
mkdir -p infra/telemetry/.state
chmod 700 infra/telemetry/.state
openssl rand -hex 32 > infra/telemetry/.state/node1.token
openssl rand -hex 32 > infra/telemetry/.state/node2.token
chmod 600 infra/telemetry/.state/*.token
cp apps/server/sources.example.json infra/telemetry/.state/sources.json
```

Compute each token's digest without its trailing newline:

```sh
tr -d '\n' < infra/telemetry/.state/node1.token | openssl dgst -sha256
tr -d '\n' < infra/telemetry/.state/node2.token | openssl dgst -sha256
```

Replace the corresponding `token_sha256` placeholders in `sources.json`. Keep its permitted host IDs consistent with the collector's `TELEMETRY_COLLECTOR_HOST_ID`. The example enrolls `pfe-compute-1` and `pfe-compute-2`. Each source has its own credential and identity. Raw credentials remain in ignored `.state` files.

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

## Query measurements

After at least one batch has been processed:

```sh
just telemetry query "SELECT host_id, metric_name, count(*) AS samples FROM measurements GROUP BY ALL ORDER BY ALL"
just telemetry query "SELECT host_id, time_unix_nano, value_int FROM measurements WHERE metric_name = 'pfe.node.memory.available' ORDER BY time_unix_nano DESC LIMIT 20"
just telemetry query "SELECT host_id, metric_name, point_attributes_json, rate_per_second FROM metric_rates WHERE metric_name IN ('pfe.node.cpu.time', 'system.disk.io') AND rate_per_second IS NOT NULL ORDER BY time_unix_nano DESC LIMIT 20"
```

[SQL views](sql/views.sql) read complete files through a read-only mount. Integer values remain `BIGINT`, timestamps `UBIGINT`, and floating-point values `DOUBLE`. Missing scalar values stay null. Resource, scope, metric and point context is retained, including diagnostics and counter segments. Original supported resource, scope and point messages are also available as binary Protobuf columns.

`metric_rates` compares cumulative monotonic sums with matching stream attributes, counter origins and identities. It does not combine devices or CPU modes, interpolate missing readings, resolve execution associations, or establish clock synchronization between nodes. Review collection diagnostics and intervals when interpreting rates. Application delta sums retain their original semantics and do not enter this view.

Local queries use a 128 MB DuckDB memory limit and up to 24 MB of temporary space. Filter rate queries by metric or stream; queries spanning every stream can exceed these limits.

## Interrupt and resume processing

```sh
just telemetry compose stop storage
# Collectors can continue exporting while Kafka retains accepted batches.
just telemetry compose start storage
just telemetry compose logs --tail 20 storage
```

The worker commits an offset after publishing a complete file. If it dies after publication but before that commit, replay recognizes the same batch and avoids duplicate rows. Consumer lag is available through the standard Kafka tool:

```sh
just telemetry compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9092 --describe --group pfe-storage-v1
```

```sh
just telemetry stop
```

Stopping services keeps both named volumes. `docker compose down --volumes` deletes retained ingestion records and historical measurements.

## Local limits

The broker uses one replica, six-hour retention and a 128 MiB per-partition retention target. Cleanup is asynchronous; active segments, metadata and internal topics use additional space. A single broker does not protect accepted data against loss of its disk. Kafka acknowledgements follow its replication and page-cache policy; this local setup does not promise survival of a host power failure. Collectors retain unacknowledged batches according to their own queue limits.

Historical Parquet files have no automatic expiry. One file per batch favors simple recovery; sustained deployments need compaction and an explicit retention policy. The setup has one storage writer and local operator queries. Browser authorization, trace storage, distributed execution associations and production TLS remain separate work.
