---
title: Collector
description: Configure the Linux collector.
---

`recount-collector` samples Linux node and process resources from `/proc` and sends them to Recount. It runs on Linux only.

## Configuration

Settings are read once at startup. Command-line flags override environment variables; run `recount-collector --help` for the flag names.

| Variable                                  | Default                     | Meaning                                                              |
| ----------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`             | `http://127.0.0.1:14317`    | Recount ingestion address.                                           |
| `RECOUNT_COLLECTOR_ENROLLMENT_URL`        | Unset                       | Address of the Recount web app that enrolls the machine.             |
| `RECOUNT_COLLECTOR_ENROLLMENT_KEY_FILE`   | Unset                       | Private file holding the enrollment key. Needed only to enroll.      |
| `RECOUNT_COLLECTOR_STATE_DIRECTORY`       | `.state/collector`          | Private folder where the machine keeps its identity after enrolling. |
| `RECOUNT_COLLECTOR_INTERVAL_MS`           | `1000`                      | Sampling period, from 100 to 60000 ms.                               |
| `RECOUNT_COLLECTOR_HOST_ID`               | `/etc/machine-id`           | Machine identity used to enroll. Cloned machines need distinct IDs.  |
| `RECOUNT_COLLECTOR_VISIBILITY`            | `restricted`                | Set to `host` only when the collector can see the host's processes.  |
| `RECOUNT_COLLECTOR_PROCESS_NAMESPACE_ID`  | `host` with host visibility | Identity of the PID namespace. Required with restricted visibility.  |
| `RECOUNT_COLLECTOR_QUEUE_DIRECTORY`       | `.state/collector-queue`    | Local folder for data waiting to be sent. One collector per folder.  |
| `RECOUNT_COLLECTOR_QUEUE_MAX_BYTES`       | `67108864`                  | Maximum queued data, from 1 MiB to 1 GiB.                            |
| `RECOUNT_COLLECTOR_QUEUE_MAX_BATCHES`     | `1024`                      | Maximum pending batches.                                             |
| `RECOUNT_COLLECTOR_QUEUE_MAX_AGE_SECONDS` | `3600`                      | How long a batch can wait before it's dropped.                       |
| `RUST_LOG`                                | `info`                      | Log level.                                                           |

Changing any setting requires a restart.

## What it collects

- **Node:** CPU time, total and available memory, disk I/O.
- **Processes:** CPU time, resident memory, disk I/O.

CPU and disk values are running totals, not percentages. The collector doesn't read command-line arguments, environment variables, executable paths, files or process memory.

## When the network drops

Data is written to the local queue before it's sent, and the collector retries temporary failures. When the queue is full, new batches are dropped and the collector records the loss. Batches older than the maximum age are dropped too.

Each queue is tied to one ingestion address and one enrolled machine. If you change either, use a new queue folder.

## Enrollment and access

On first start the collector creates a private key in its state folder and enrolls with the enrollment key. It then appears under **Nodes** in **Project settings → Collectors**, and the key file can be removed. From then on it renews a short-lived access token by itself, so there is nothing to rotate on the machine.

To stop a machine from sending data, revoke its node on the Collectors page; this takes effect within about 30 seconds. Revoking an enrollment key stops new machines from enrolling but leaves enrolled ones running. To enroll a revoked or deleted machine again, delete `node.json` and `node.key` from its state folder, use a new queue folder and start it with an active enrollment key.

## Next steps

- [Record an execution](/docs/quick-start/#5-record-an-execution) to see what a machine was doing.
- [Host Recount yourself](/docs/self-hosting/) if your data must stay on your network.
