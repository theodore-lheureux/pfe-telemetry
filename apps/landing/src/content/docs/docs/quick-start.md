---
title: Quick start
description: Connect your first machine and record an execution.
---

This guide takes you from a new project to your first execution page. You need a Linux machine to run the collector on.

## 1. Create a project

Sign in and create a project in your organization. Organization owners and admins can create projects.

## 2. Create an enrollment key

As a project admin, open **Project settings → Collectors** and choose **Create enrollment key**. Give it a name, such as `build-servers`, and choose **Create enrollment key**.

The key is shown only once, so save it before closing the dialog. One key can enroll every machine in a fleet.

## 3. Save the key on the machine

Store the key in a file that only your user can read:

```sh
install -d -m 700 ~/.config/recount
(umask 077 && cat > ~/.config/recount/enrollment.key)
# Paste the key, press Enter, then Ctrl-D
```

Keep the key out of command arguments, shell history, tickets and logs.

## 4. Start the collector

Point the collector at the Recount web app, which enrolls the machine, and at the ingestion address, which receives its telemetry:

```sh
export RECOUNT_COLLECTOR_ENROLLMENT_URL=https://your-recount-app.example
export RECOUNT_COLLECTOR_ENROLLMENT_KEY_FILE=~/.config/recount/enrollment.key
export RECOUNT_COLLECTOR_STATE_DIRECTORY=~/.local/state/recount
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ca.ingest.recount.cloud
recount-collector
```

Use the address you sign in at as the enrollment URL. The ingestion address shown is the one for Recount Cloud; if you [self-host](/docs/self-hosting/), use your own. On first start the machine enrolls itself and appears under **Nodes** on the Collectors page.

## 5. Record an execution

In the project, open **Executions** and choose **Record execution**. Pick the node, optionally a host, and a start and end time. A window can be up to seven days long.

Open the saved execution to see the machine's telemetry for that window.

## Next steps

- [Run the collector on each machine you want to watch](/docs/collector/), and keep it running in the background.
- [Learn how projects, roles and executions fit together](/docs/concepts/).
