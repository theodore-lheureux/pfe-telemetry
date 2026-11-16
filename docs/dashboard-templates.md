# Dashboard templates

Templates are snapshots of dashboard settings and saved-insight drafts. Creating a dashboard copies the snapshot into ordinary saved insights and dashboard tiles. Editing or deleting the source dashboard does not change its template or dashboards created from it.

## PostHog comparison

PostHog's [template model](https://github.com/PostHog/posthog/blob/master/products/dashboards/backend/models/dashboard_templates.py) stores JSON tiles, dashboard filters, variables, customization, tags and an optional image URL. Global templates can have no owning team. Customer templates belong to a team (PostHog's project), with team or organization visibility.

The [gallery](https://github.com/PostHog/posthog/blob/master/products/dashboards/frontend/dashboards/templates/DashboardTemplateChooser.tsx) combines official templates, project/organization templates and a blank-dashboard choice. Official cards can display cover images; project templates can appear without them. The [documented creation flow](https://posthog.com/docs/product-analytics/dashboards) starts from this gallery, then collects dashboard details.

PostHog's [creation logic](https://github.com/PostHog/posthog/blob/master/frontend/src/scenes/dashboard/newDashboardLogic.ts) replaces variable placeholders in template JSON before submission. Its current variable selector primarily configures events and actions. The [server helper](https://github.com/PostHog/posthog/blob/master/posthog/helpers/dashboard_templates.py) then creates ordinary insights and tiles from their query and layout definitions. Variables used to instantiate a template are distinct from runtime SQL/dashboard variables.

“Save as dashboard template” captures the dashboard's definitions and asks for a name, description and optional tags. The [template API](https://github.com/PostHog/posthog/blob/master/products/dashboards/backend/presentation/views/dashboard_templates.py) restricts customer writes to templates owned by the current project. Organization sharing warns about project-specific references.

| Area                   | Recount choice                                                                                                                                                                   | Reason                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Format                 | Adopt snapshots of existing dashboard filters, tile layout/options/overrides and saved-insight drafts.                                                                           | No second query or visualization language.                                                                          |
| Storage                | Bundled JSON for built-ins; one project-owned snapshot table for member templates.                                                                                               | Built-ins need no database seeding; snapshots survive source edits and deletion.                                    |
| Gallery                | Adopt blank, built-in and project choices, with a layout preview and per-panel coverage.                                                                                         | Users can inspect requirements before creating anything.                                                            |
| Coverage               | Keep the existing 60% recommendation threshold. A panel needs every metric with a supported calculation.                                                                         | Discovery coverage is useful evidence, not a promise that the selected time range contains data.                    |
| Variables              | Adapt creation-time substitution to a typed `$node` filter declaration. Resolve it server-side to a selected project node or explicitly all nodes.                               | Covers Node health without adding runtime variable infrastructure or interpolating query text.                      |
| Save as template       | Members/admins save a persisted dashboard snapshot; optionally ask for `$node` on creation instead of retaining its dashboard-level node filter.                                 | Matches project write permissions and makes customized dashboards reusable.                                         |
| Previews               | Derive a structural preview from the snapshot, showing panel names, visualization types and availability. Keep the live Node health overview on the ordinary dashboard renderer. | No image uploads, external image requests, thumbnail jobs or speculative queries.                                   |
| Sharing and management | Skip organization/global publishing, cross-project copying, tags and a template editor.                                                                                          | Project-local calculated references stay in their authorized project; these features are outside the required flow. |

## Creation and access

Every template list, save and instantiation independently checks current project access. Readers may browse; members and admins may save templates and create dashboards. Built-ins are immutable. Project template IDs are always resolved with both organization and project predicates.

Creation validates the snapshot's drafts through the saved-insight validator and checks project-owned calculation references before inserting insights. Dashboard, insights and tiles commit together. A retried create uses the same dashboard ID and does not reseed tiles.

`$node` is metadata, not a string inserted into an insight query. Selecting a node adds a normal dashboard `node = …` filter; selecting all nodes adds no node predicate. Existing per-insight and per-tile filters retain their normal semantics, including tiles that ignore dashboard filters. The created dashboard remains editable using the existing filter controls. Saving a template captures persisted settings, not unsaved URL overrides.
