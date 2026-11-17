# Dashboard templates

Templates are snapshots of dashboard settings and saved-insight drafts. Creating a dashboard copies the snapshot into ordinary saved insights and dashboard tiles. Editing or deleting the source dashboard does not change its template or dashboards created from it.

## PostHog comparison

PostHog's [template model](https://github.com/PostHog/posthog/blob/master/products/dashboards/backend/models/dashboard_templates.py) stores JSON tiles, dashboard filters, variables, customization, tags and an optional image URL. Global templates can have no owning team. Customer templates belong to a team (PostHog's project), with team or organization visibility.

The [gallery](https://github.com/PostHog/posthog/blob/master/products/dashboards/frontend/dashboards/templates/DashboardTemplateChooser.tsx) combines official templates, project/organization templates and a blank-dashboard choice. Official cards can display cover images; project templates can appear without them. The [documented creation flow](https://posthog.com/docs/product-analytics/dashboards) starts from this gallery, then collects dashboard details.

PostHog's [creation logic](https://github.com/PostHog/posthog/blob/master/frontend/src/scenes/dashboard/newDashboardLogic.ts) replaces variable placeholders in template JSON before submission. Its current variable selector primarily configures events and actions. The [server helper](https://github.com/PostHog/posthog/blob/master/posthog/helpers/dashboard_templates.py) then creates ordinary insights and tiles from their query and layout definitions. Variables used to instantiate a template are distinct from runtime SQL/dashboard variables.

“Save as dashboard template” captures the dashboard's definitions and asks for a name, description and optional tags. The [template API](https://github.com/PostHog/posthog/blob/master/products/dashboards/backend/presentation/views/dashboard_templates.py) restricts customer writes to templates owned by the current project. Organization sharing warns about project-specific references.

| Area                   | Recount choice                                                                                                                                                                 | Reason                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Format                 | Adopt snapshots of existing dashboard filters, tile layout/options/overrides and saved-insight drafts.                                                                         | No second query or visualization language.                                                                          |
| Storage                | Bundled JSON for built-ins; one project-owned snapshot table for member templates.                                                                                             | Built-ins need no database seeding; snapshots survive source edits and deletion.                                    |
| Gallery                | Adopt blank, built-in and project choices, with a layout preview and per-panel coverage.                                                                                       | Users can inspect requirements before creating anything.                                                            |
| Coverage               | Keep the existing 60% recommendation threshold. A panel needs every metric with a supported calculation.                                                                       | Discovery coverage is useful evidence, not a promise that the selected time range contains data.                    |
| Variables              | Adapt creation-time substitution to typed `$node` and `$execution` filter declarations. Resolve them server-side to a project node (or all nodes) and to a project execution.  | Covers Node health and Execution without adding runtime variable infrastructure or interpolating query text.        |
| Save as template       | Members/admins save a persisted dashboard snapshot; optionally ask for `$node` on creation instead of retaining its dashboard-level node filter.                               | Matches project write permissions and makes customized dashboards reusable.                                         |
| Previews               | Derive a structural preview from the snapshot, showing panel names, visualization types and availability. Show live Node health and execution views on the dashboard renderer. | No image uploads, external image requests, thumbnail jobs or speculative queries.                                   |
| Sharing and management | Skip organization/global publishing, cross-project copying, tags and a template editor.                                                                                        | Project-local calculated references stay in their authorized project; these features are outside the required flow. |

## Creation and access

Every template list, save and instantiation independently checks current project access. Readers may browse; members and admins may save templates and create dashboards. Built-ins are immutable. Project template IDs are always resolved with both organization and project predicates.

Creation validates the snapshot's drafts through the saved-insight validator and checks project-owned calculation references before inserting insights. Dashboard, insights and tiles commit together. A retried create uses the same dashboard ID and does not reseed tiles.

`$node` is metadata, not a string inserted into an insight query. Selecting a node adds a normal dashboard `node = …` filter; selecting all nodes adds no node predicate. Existing per-insight and per-tile filters retain their normal semantics, including tiles that ignore dashboard filters. The created dashboard remains editable using the existing filter controls. Saving a template captures persisted settings, not unsaved URL overrides.

## Variables

A template declares variables in `variables`. Each one names a field, and filling it adds an ordinary dashboard `eq` filter on that field. Creation accepts only the variables the template declares.

| Variable     | Field       | Value                         | Creation                                                                                                                                           |
| ------------ | ----------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$node`      | `node`      | A project node ID, or `null`. | The node must belong to the project. `null` means all nodes and adds no filter.                                                                    |
| `$execution` | `execution` | An execution key.             | Required. The key is read from ClickHouse only after project access is checked, with the project predicate. An unknown key fails with `NOT_FOUND`. |

Filling `$execution` also sets the dashboard range to the execution's period, from its first observation through its last, widened to whole minutes. A range ending just after the last observation would leave a nearly empty last bucket, and rates divide each bucket's increase by the time it covers. An execution longer than 30 days, the longest range a query reads, shows its last 30 days. Tiles marked `executionNodes` gain a tile filter `node in …` naming up to 50 of the nodes the execution was seen on, which keeps their overrides well under the 4,096-character limit when members add their own. The execution view says when either limit applies.

These values are fixed when the dashboard is created or the execution view is loaded; later filter changes do not re-resolve them. For a running execution, the range ends at the minute after its latest observation, so the last minute can extend past the current time and its rates read low until it ends. Reload the view to follow the execution.

## Execution template

The Execution template shows an execution's processes across its nodes, with the same measures for those whole nodes and the cluster as context.

| Panels                                       | Query                                                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU time, peak memory, disk read and written | Number tiles over the whole range: the `process.cpu.time` and `process.disk.io` used during the observed period, and the sum of each process's `recount.process.memory.rss` peak. |
| Execution CPU, memory and disk throughput    | The same process metrics over time, by node.                                                                                                                                      |
| Node CPU busy, memory used and disk          | `recount.node.cpu.time` outside idle, total minus available memory and `system.disk.io`, by node, on the execution's nodes.                                                       |
| Cluster CPU busy and memory used             | The same node measures across every project node.                                                                                                                                 |

CPU time and disk totals count what each process used between its first and last samples. Usage before a process's first sample, such as CPU time accumulated before the collector saw it, is not included.

Context tiles set the tile override `ignoreFilters: ["execution"]`. They keep the dashboard's range and other filters, but node measurements have no process to attribute to an execution, so the execution filter would remove them. A tile's overrides dialog can turn this off or drop the dashboard's filters on its current fields. A Number tile with `wholeRange` runs as one table-shaped value over the range instead of showing its latest bucket. Per-process breakdowns are omitted: PIDs repeat across nodes and resource IDs are opaque.

Opening an execution's dashboard shows this template filled for that execution, without saving anything. Its overrides live in the URL. Members and admins can create a saved dashboard from it, named after the execution, with the same execution.
