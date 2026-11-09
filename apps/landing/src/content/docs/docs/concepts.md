---
title: Concepts
description: Organizations, projects, roles, sources and executions.
---

## Organizations and projects

An organization holds your projects and members. A project is the boundary for data and access: telemetry, collectors and executions all belong to one project. Use separate projects for unrelated work.

## Roles

Projects are private by default. Organization owners and admins have admin access to every project in the organization. Other members need a project role:

| Role   | Can do                                                                     |
| ------ | -------------------------------------------------------------------------- |
| Viewer | See every execution in the project.                                        |
| Member | Everything a viewer can, plus rename their own executions.                 |
| Admin  | Everything, including project settings, members and collector credentials. |

## Sources and credentials

A source is what reports telemetry, usually one collector on one machine. Each collector credential enrolls a source in a project and decides which machine it may report for.

You can rotate a credential to get a new token, or revoke it to stop that source from sending more data. Revoking one credential doesn't affect the others. To change what a credential allows, create a new one and revoke the old one.

## Executions

An execution is a saved time window on one source, optionally narrowed to a host. Everyone who can read the project can open every execution in it.

An execution doesn't track whether a job is running or finished. It records the window you chose, and shows what the machine was doing during it.

## Missing data

Recount never fills in gaps. When a reading is missing, the chart shows a gap instead of a zero. Measurements keep their original timestamps, even when they arrive late.
