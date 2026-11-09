---
title: Self-hosting
description: Run Recount on your own servers.
---

You can run Recount on your own infrastructure instead of using Recount Cloud. It's the same product, and your telemetry never leaves your network.

:::note
Packaged releases for self-hosting are on the way. This page will cover installation and upgrades once they're available.
:::

## What you run

A Recount installation has three parts:

- **The web app**, where your team signs in, manages projects and looks at saved moments.
- **The ingestion service**, which receives telemetry from your collectors. Your machines need to reach it over the network.
- **Storage**, which keeps your accounts, projects and telemetry.

Each part runs as a container, so you can use the tools you already have for running and monitoring services.

## Connecting collectors

Collectors work the same way as with Recount Cloud. When you follow the [quick start](/docs/quick-start/), point the collector at your own ingestion address instead of the cloud one.

## Cloud or self-hosted?

- **Recount Cloud** is the quickest way to start. There's nothing to install or maintain.
- **Self-hosting** suits teams that need their data to stay on their own network, or that already run their own services.

## Next steps

- [Follow the quick start](/docs/quick-start/) with your own ingestion address.
- [Read about projects and roles](/docs/concepts/) before inviting your team.
