# Set up project collectors

Collectors enroll themselves into a project with an enrollment key; [collector enrollment](collector-enrollment.md) explains the mechanism. Effective project admins manage keys and nodes at **Project settings → Collectors**. Organization owners and admins have effective project admin access; project readers cannot see either list.

## Create an enrollment key

1. Choose **Create enrollment key**.
2. Enter a name that identifies the fleet or environment, such as `prod-linux`.
3. Optionally add comma-separated labels, which every node enrolled with the key receives, a node limit and an expiry. Use a short expiry and a limit for one-off keys.
4. Create the key and save it from the reveal dialog. The key is shown only once; hiding the dialog, reloading or leaving the page discards it. If it is lost, revoke the key and create another.

New Linux keys allow process and container resources and use a maximum submission age of 3600 seconds with 60 seconds of clock skew. Keep each collector's queue lifetime no greater than the submission age.

Store the key where only the collector's user can read it, without putting it in command arguments, shell history, URLs or tickets:

```sh
sudo install -d -m 0700 /etc/recount-collector
sudo sh -c 'umask 077; cat > /etc/recount-collector/enrollment.key'
```

Paste the key, press Enter, then Ctrl-D. Configuration management can install the same file on every machine in the fleet.

## Run the collector

The [Linux collector configuration](../apps/collector/README.md#configuration) is authoritative for flags and environment variables. Each machine needs:

- `RECOUNT_COLLECTOR_ENROLLMENT_URL`: the web application URL, for example `https://recount.example`.
- `RECOUNT_COLLECTOR_ENROLLMENT_KEY_FILE`: the path of the private key file, not the key itself.
- `RECOUNT_COLLECTOR_STATE_DIRECTORY`: a persistent private directory for the node identity.
- `OTEL_EXPORTER_OTLP_ENDPOINT`: the [ingestion API's](../apps/ingestion-api/README.md) OTLP/gRPC endpoint. The web application URL is not an ingestion endpoint.
- A verified process namespace ID and visibility, as described in the collector README.

```sh
RECOUNT_COLLECTOR_ENROLLMENT_URL=https://recount.example \
RECOUNT_COLLECTOR_ENROLLMENT_KEY_FILE=/etc/recount-collector/enrollment.key \
RECOUNT_COLLECTOR_STATE_DIRECTORY=/var/lib/recount-collector/node \
RECOUNT_COLLECTOR_QUEUE_DIRECTORY=/var/lib/recount-collector \
OTEL_EXPORTER_OTLP_ENDPOINT=http://ingestion.internal:4317 \
RECOUNT_COLLECTOR_VISIBILITY=host \
recount-collector
```

On first start the collector enrolls and appears in the **Nodes** table with its hostname and machine ID. Later starts reuse the stored identity, so the key file can be removed once the node is listed. The current collector supports plaintext OTLP endpoints only: use loopback or a trusted private network or tunnel. Follow the [stack guide](../infra/README.md) for initialization, schema artifacts and endpoint publication.

## Revoke and remove

- **Revoke an enrollment key** to stop new enrollments. Nodes it already enrolled keep working.
- **Revoke nodes** from the Nodes table to stop their submissions within about 30 seconds. They stay listed with status Revoked.
- **Delete nodes** to revoke them and remove them from the list. Their telemetry stays queryable. The machine can enroll again as a new node after its `node.json` and `node.key` are removed.

Records already accepted into Kafka may finish normalization after a node is revoked; the normalizer does not check node state. Private project reads still authorize independently. An ingestion acknowledgement confirms raw publication, not immediate ClickHouse queryability.
