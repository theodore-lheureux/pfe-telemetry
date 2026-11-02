# Enroll a project collector

An effective project administrator can manage collector credentials at **Project settings → Collector credentials**. Organization owners and admins have effective project admin access. Project readers cannot list credentials or change enrollment.

## Create a credential

1. Enter a descriptive credential name and a stable source ID. Multiple credentials may enroll the same source in a project.
2. Enter exact allowed host IDs, one per line. Use the collector’s explicit `--host-id` value or its default `/etc/machine-id`. Wildcards have no special meaning. Source and host IDs must contain 1–128 UTF-8 bytes without control characters.
3. Keep **Require host identification** enabled for the Linux collector. If disabled, submissions without a host ID are allowed; any provided host ID must still be in the allowlist. The Linux collector normally supplies a host ID.
4. Optionally set a future expiration in your local time. Submission timing policy defaults to a maximum age of 3600 seconds and clock skew of 60 seconds.
5. Create the credential and save its token in the collector’s private token file. The page reveals the raw token only immediately after creation or rotation. Hiding it, reloading, changing accounts, or leaving the page discards the reveal. The credential list cannot recover it.

Use the page’s Linux build and Bash token-file instructions. They keep the token out of command arguments and shell history, and create its directory with mode `0700` and file with mode `0600`. Do not enable shell tracing. Clipboard copying is optional and occurs only when you choose **Copy token**; if the browser denies access, select and copy manually. Clear your clipboard after saving the token. Do not put tokens in URLs, browser storage, tickets, or logs.

## Run the collector

The [Linux collector configuration](../apps/collector/README.md#configuration) is authoritative for supported flags and environment variables. Set `--source-token-file` or `TELEMETRY_COLLECTOR_SOURCE_TOKEN_FILE` to the private file’s path, not the token itself. The credential enrolls the project and source; there are no project-ID or source-ID collector flags.

Configure the ingestion service’s OTLP/gRPC endpoint, an enrolled host ID and a verified boot-local process namespace ID. Keep restricted visibility unless deployment has verified initial-host PID visibility. The current collector supports HTTP only: use loopback or a trusted private network/tunnel, not an unprotected public network. The web application’s URL is not an ingestion endpoint.

## Rotate or revoke

Rotation invalidates the old token immediately and reveals a replacement once. It is not a seamless handover:

1. Stop every affected collector with SIGINT or SIGTERM while the old token is valid. With the unchanged token, endpoint and queue settings, run `pfe-collector --drain` to export pending uploads without sampling. Inspect rejection and loss diagnostics: drain uses ordinary retry, terminal-rejection and expiry policies, so an empty queue does not prove every batch was accepted. Keep the old token active until drain finishes.
2. Confirm rotation and replace the private token file. The collector reads that file only at startup; running collectors keep the invalidated token.
3. Restart with a **new private queue directory** and retain the old queue without modifying it. The [persistent queue](../apps/collector/README.md#authenticated-ingestion) is bound to the endpoint and token digest, and refuses a replacement token; existing queued uploads cannot be replayed under the rotated credential.

Revocation permanently prevents new submissions with that credential. Expired or revoked credentials cannot rotate. Enrollment policies are immutable: to change source, hosts, timing or expiry, create a replacement credential and revoke the previous one.

If a mutation response is lost, refresh the list before retrying. Creation or rotation may have succeeded even though no token appeared. A lost token cannot be recovered; rotate its credential to obtain a replacement. Do not automatically repeat rotations.
