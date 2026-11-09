---
title: Quick start
description: Connect your first machine and record an execution.
---

This guide takes you from a new project to your first execution page. You need a Linux machine to run the collector on.

## 1. Create a project

Sign in and create a project in your organization. Organization owners and admins can create projects.

## 2. Create a collector credential

As a project admin, open **Project settings → Collector credentials** and choose **Create collector credential**.

- **Credential name:** anything that helps you recognize it later.
- **Source ID:** a stable name for what's reporting, for example `build-server-1`.
- **Root ID:** the machine's identity. By default the collector uses `/etc/machine-id`. Run `cat /etc/machine-id` on the machine to get it.

Choose **Create credential**. The token is shown only once, so save it before leaving the page.

## 3. Save the token on the machine

Store the token in a file that only your user can read. The credential page shows commands for this. One way to do it:

```sh
install -d -m 700 ~/.config/recount
(umask 077 && cat > ~/.config/recount/source.token)
# Paste the token, press Enter, then Ctrl-D
```

Keep the token out of command arguments, shell history, tickets and logs.

## 4. Start the collector

Point the collector at the Recount ingestion address and the token file:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ca.ingest.recount.cloud
export RECOUNT_COLLECTOR_SOURCE_TOKEN_FILE=~/.config/recount/source.token
recount-collector
```

This is the address for Recount Cloud. If you [self-host](/docs/self-hosting/), use your own ingestion address instead. Either way, it is not the web app's URL.

## 5. Record an execution

In the project, open **Executions** and choose **Record execution**. Pick the source, optionally a host, and a start and end time. A window can be up to seven days long.

Open the saved execution to see the machine's telemetry for that window.

## Next steps

- [Run the collector on each machine you want to watch](/docs/collector/), and keep it running in the background.
- [Learn how projects, roles and executions fit together](/docs/concepts/).
