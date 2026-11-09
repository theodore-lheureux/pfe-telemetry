---
title: Introduction
description: What Recount is and how it's organized.
---

Recount gathers telemetry from your machines and keeps it in one place. You save the time windows you care about, such as a release, a test or a slowdown, and come back later to see what each machine was doing.

You can use **Recount Cloud**, which we run for you, or [host Recount yourself](/docs/self-hosting/). Both work the same way, and these docs apply to both.

## How it fits together

- **Organizations and projects.** Everything lives in a project. Projects are private, and only the people you add can see them.
- **Collectors.** A small program runs on each Linux machine and sends telemetry to Recount. Each one uses a credential created in the project, so only machines you enroll can send data.
- **Executions.** An execution is a saved time window on one source, optionally narrowed to one host. Opening it shows what that machine was doing during the window.

## What you can see today

An execution page charts node CPU time and memory for the selected window. The collector also records disk and per-process measurements. Those are stored but not charted yet.

Charts show what the machine was doing during the window. They don't prove that a specific job caused that activity, and two overlapping executions can show the same data.

## Next steps

- [Quick start](/docs/quick-start/): connect your first machine.
- [Concepts](/docs/concepts/): projects, roles, sources and executions.
- [Collector](/docs/collector/): configuration reference.
