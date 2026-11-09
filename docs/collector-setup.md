# Enroll a project collector

An effective project administrator can manage collector credentials at **Project settings → Collector credentials**. Organization owners and admins have effective project admin access. Project readers cannot list credentials or change enrollment.

## Create a credential

1. Enter a descriptive credential name and a stable source ID. Multiple credentials may enroll the same source in a project.
2. Enter the exact enrolled root ID. Use the Linux collector's explicit `--host-id` value or its default `/etc/machine-id`. Cloned machine IDs need distinct enrolled roots. Source and resource IDs must contain 1–128 UTF-8 bytes without control characters; spelling is case-sensitive and wildcards grant nothing.
3. The current form creates a host root with adapter `linux` and explicit permission for local process resources. It does not enroll every PID or expose a host allowlist. Root reporting permission is not physical attestation, and payload parent/placement claims do not expand it. The server-function API supports additional typed roots and independent-resource bindings; see [credential policy](collector-credentials.md#enrollment-policy).
4. Optionally set a future expiration in your local time. Upload timing defaults to maximum submission age 3600 seconds and clock skew 60 seconds; skew can be zero. Keep the collector's queue lifetime no greater than the enrolled upload age. This policy checks declared batch creation, not individual measurement age, and does not rewrite source timestamps.
5. Create the credential and save its token in the collector’s private token file. The page reveals the raw token only immediately after creation or rotation. Hiding it, reloading, changing accounts, or leaving the page discards the reveal. The credential list cannot recover it.

Use the page’s Linux build and Bash token-file instructions. They keep the token out of command arguments and shell history, and create its directory with mode `0700` and file with mode `0600`. Do not enable shell tracing. Clipboard copying is optional and occurs only when you choose **Copy token**; if the browser denies access, select and copy manually. Clear your clipboard after saving the token. Do not put tokens in URLs, browser storage, tickets, or logs.

## Run the collector

The [Linux collector configuration](../apps/collector/README.md#configuration) is authoritative for supported flags and environment variables. Set `--source-token-file` or `RECOUNT_COLLECTOR_SOURCE_TOKEN_FILE` to the private file's path, not the token itself. The credential establishes project/source and root grants; there are no project-ID or source-ID collector flags. Compile Linux artifacts on the host and run repository validation only in Docker; no compiler belongs in the runtime image.

Configure the [ingestion API's](../apps/ingestion-api/README.md) OTLP/gRPC endpoint, the enrolled root ID and a verified boot-local process namespace ID. Keep restricted visibility unless deployment has verified initial-host PID visibility; container visibility must match the actual procfs/PID namespace, not merely a `host` flag. The current collector supports plaintext HTTP endpoints only: use loopback or a trusted private network/tunnel, not an unprotected public network. The web application's URL is not an ingestion endpoint. Follow the [stack guide](../infra/README.md) for explicit initialization, mounts, schema artifacts and endpoint publication rather than assuming a running container is ready.

## Rotate or revoke

Rotation invalidates the old token immediately and reveals a replacement once. It is not a seamless handover:

1. Stop every affected collector with SIGINT or SIGTERM while the old token is valid. With the unchanged token, endpoint and queue settings, run `recount-collector --drain` in its Linux runtime to export pending uploads without sampling. Inspect rejection and loss diagnostics: drain uses ordinary retry, terminal-rejection and expiry policies, so an empty queue does not prove every batch was accepted. Keep the old token active until drain finishes.
2. Confirm rotation and replace the private token file. The collector reads that file only at startup; running collectors keep the invalidated token.
3. Restart with a **new private queue directory** and retain the old queue without modifying it. The [persistent queue](../apps/collector/README.md#authenticated-ingestion) is bound to the endpoint and token digest, and refuses a replacement token; existing queued uploads cannot be replayed under the rotated credential.

Revocation permanently prevents new submissions with that credential. Expired or revoked credentials cannot rotate. Enrollment policies are immutable through the management API: to change source, root/resource grants, timing or expiry, create a replacement credential and revoke the previous one. Rotation preserves the same source/root policy and stable observation identities, but it does not make the old local queue usable with a replacement token.

Records already accepted into Kafka may finish normalization after revocation or upload-age expiry; the normalizer does not refresh credential state. Private project reads still authorize independently. An ingestion acknowledgement confirms raw publication, not immediate ClickHouse queryability or an entire batch becoming visible together.

If a mutation response is lost, refresh the list before retrying. Creation or rotation may have succeeded even though no token appeared. A lost token cannot be recovered; rotate its credential to obtain a replacement. Do not automatically repeat rotations.
