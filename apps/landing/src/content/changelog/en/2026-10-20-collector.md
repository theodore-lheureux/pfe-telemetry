---
title: Collector and ingestion
date: 2026-10-20
---

The first pieces of Recount: getting telemetry off your machines and into one place.

### New

- **Collector for Linux.** A small program runs on each machine and sends its telemetry to Recount.
- **No lost data.** The collector keeps what it measures on disk and catches up after a dropped connection or a restart.
- **Only trusted machines.** Recount accepts telemetry only from machines with a valid credential, and data sent twice is stored only once.
