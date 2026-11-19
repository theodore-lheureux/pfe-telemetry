---
title: Concepts
description: Organizations, projects, roles, sources and executions.
---

## Organizations and projects

An organization holds your projects and members. A project is the boundary for data and access: telemetry, collectors and executions all belong to one project. Use separate projects for unrelated work.

## Roles

Projects are private by default. Organization owners and admins have admin access to every project in the organization. Other members need a project role:

| Role   | Can do                                                          |
| ------ | --------------------------------------------------------------- |
| Viewer | See every execution in the project.                             |
| Member | Everything a viewer can, plus rename their own executions.      |
| Admin  | Everything, including project settings, members and collectors. |

## Nodes and enrollment keys

A node is one machine that reports telemetry to a project, through the collector running on it. Machines enroll themselves with an enrollment key created in the project, so you can add a whole fleet with one key.

Revoking a node stops that machine from sending more data without affecting the others. Revoking an enrollment key stops new machines from enrolling with it; machines it already enrolled keep reporting.

## Executions

An execution is a saved time window on one node, optionally narrowed to a host. Everyone who can read the project can open every execution in it.

An execution doesn't track whether a job is running or finished. It records the window you chose, and shows what the machine was doing during it.

## Missing data

Recount never fills in gaps. When a reading is missing, the chart shows a gap instead of a zero. Measurements keep their original timestamps, even when they arrive late.

Insights and time-series dashboard panels, including Node health, mark periods that may not be stored yet with a hatched **Data still arriving** band. Hover over it for the estimated delay. A **No data received** band means no collector heartbeat was stored for that period after allowing for the normal send delay. It does not mean the machines were offline: collectors can send queued measurements later.

## Next steps

- [Connect a machine](/docs/quick-start/) and record your first execution.
- [Configure the collector](/docs/collector/) for your machines.
