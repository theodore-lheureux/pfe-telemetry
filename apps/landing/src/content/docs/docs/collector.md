---
title: Collector
description: Configure the Linux collector.
---

`recount-collector` samples Linux node and process resources from `/proc` and sends them to Recount. It runs on Linux only.

## Configuration

Settings are read once at startup. Command-line flags override environment variables; run `recount-collector --help` for the flag names.

| Variable                                  | Default                     | Meaning                                                             |
| ----------------------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`             | `http://127.0.0.1:14317`    | Recount ingestion address.                                          |
| `RECOUNT_COLLECTOR_SOURCE_TOKEN_FILE`     | Unset                       | Path to the private file holding the collector credential's token.  |
| `RECOUNT_COLLECTOR_INTERVAL_MS`           | `1000`                      | Sampling period, from 100 to 60000 ms.                              |
| `RECOUNT_COLLECTOR_HOST_ID`               | `/etc/machine-id`           | Machine identity. Must match the root ID on the credential.         |
| `RECOUNT_COLLECTOR_VISIBILITY`            | `restricted`                | Set to `host` only when the collector can see the host's processes. |
| `RECOUNT_COLLECTOR_PROCESS_NAMESPACE_ID`  | `host` with host visibility | Identity of the PID namespace. Required with restricted visibility. |
| `RECOUNT_COLLECTOR_QUEUE_DIRECTORY`       | `.state/collector-queue`    | Local folder for data waiting to be sent. One collector per folder. |
| `RECOUNT_COLLECTOR_QUEUE_MAX_BYTES`       | `67108864`                  | Maximum queued data, from 1 MiB to 1 GiB.                           |
| `RECOUNT_COLLECTOR_QUEUE_MAX_BATCHES`     | `1024`                      | Maximum pending batches.                                            |
| `RECOUNT_COLLECTOR_QUEUE_MAX_AGE_SECONDS` | `3600`                      | How long a batch can wait before it's dropped.                      |
| `RUST_LOG`                                | `info`                      | Log level.                                                          |

Changing any setting requires a restart.

## What it collects

- **Node:** CPU time, total and available memory, disk I/O.
- **Processes:** CPU time, resident memory, disk I/O.

CPU and disk values are running totals, not percentages. The collector doesn't read command-line arguments, environment variables, executable paths, files or process memory.

## When the network drops

Data is written to the local queue before it's sent, and the collector retries temporary failures. When the queue is full, new batches are dropped and the collector records the loss. Batches older than the maximum age are dropped too.

Each queue is tied to one ingestion address and one token. If you change either, use a new queue folder.

## Rotating a token

1. Stop the collector while the old token is still valid.
2. Run `recount-collector --drain` with the old token to send anything still queued.
3. Rotate the credential and replace the token file.
4. Start the collector again with a new queue folder.

## Next steps

- [Record an execution](/docs/quick-start/#5-record-an-execution) to see what a machine was doing.
- [Host Recount yourself](/docs/self-hosting/) if your data must stay on your network.
