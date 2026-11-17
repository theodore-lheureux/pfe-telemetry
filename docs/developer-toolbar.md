# Developer toolbar

The project workspace has a floating Recount developer toolbar for explicitly
allowlisted users. It delegates execution to native Ansible templates in Semaphore
Community 2.20.23. It does not provision infrastructure itself or change application
memberships.

The non-modal panel leaves the application usable behind it. Drag its header or
focus the header and press Space, arrow keys and Space to move it with the keyboard.
Escape cancels a move. Its position stays in memory across closing/reopening and
is constrained when the viewport or panel size changes. Cost and destructive
confirmations remain modal.

## Configure the web application

Set these **server-only** environment variables in the web application's secret
configuration. Do not use `VITE_` variables or commit real values.

| Setting                         | Value                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `RECOUNT_DEVELOPER_USER_IDS`    | Comma-separated canonical Better Auth user IDs; configure Theodore's actual user ID explicitly |
| `RECOUNT_SEMAPHORE_UNIX_SOCKET` | Absolute private Unix socket path; preferred host-local transport                              |
| `RECOUNT_SEMAPHORE_URL`         | Explicit HTTPS API root URL when not using a Unix socket                                       |
| `RECOUNT_SEMAPHORE_UI_URL`      | Required separate HTTPS native UI root URL; never inferred from the API transport              |
| `RECOUNT_SEMAPHORE_PROJECT_ID`  | Positive native Semaphore project ID                                                           |
| `RECOUNT_SEMAPHORE_TOKEN`       | Bearer API token for a dedicated non-admin native account                                      |
| `RECOUNT_SEMAPHORE_GPU_ENABLED` | Defaults to disabled; only the exact value `true` enables GPU creation                         |
| `RECOUNT_DEVELOPER_LAB_GRANTS`  | Optional server-owned JSON object granting existing-lab operations, described below            |

Missing allowlist or invalid connector configuration hides the entry point.
An allowlisted user without current project-admin access also receives a null
capability; developer discovery does not break ordinary project navigation.
Ordinary users receive a null capability, no task payload and no upstream request.
Organization administration, email domains and application environment mode never
grant developer access.

### Private transport

Prefer the host-local Unix socket exposed by the deployment's systemd proxy. The
connector uses Bun's `fetch(url, { unix: socketPath })`, fixed internal authority
`http://localhost`, and its ordinary scoped bearer token. It does not create the
socket, proxy, service account or deployment wiring.

Socket paths must be absolute, normalized, non-root paths without control
characters, whitespace or a trailing slash, using at most 107 printable ASCII
bytes. Configure
exactly one of the socket and HTTPS API URL. An empty/invalid socket setting or
mixed transport settings disables the connector; socket errors never fall back
to external HTTP. Redirects are rejected in either mode. No Cloudflare hostname,
service token or privileged proxy is required by this implementation.

Native task links use only the separately configured HTTPS UI URL, with the
viewer's own native sign-in. The private socket path, internal authority, API
transport URL, bearer token and request headers are not returned to the browser.

Existing-lab operations need an explicit server-owned grant:

```json
{
  "demo-example": {
    "organizationId": "<canonical organization ID>",
    "projectId": "<Recount project UUID>",
    "fleet": "aws-cpu"
  }
}
```

An operator must verify the lab's current project and fleet before installing this
grant. It is an authorization grant, not discovered VM inventory or proof that a
lab still exists. Remove it after Destroy; update it after a successful Move.
Configure and Destroy require the grant to match the selected project. Move requires
current canonical project administration on both the granted source and selected
destination. Missing, malformed or mismatched grants fail before any upstream call.
No grant is generated automatically from human-readable logs.

All four load operations require the same lab grant and current project
administration before submission. Reading their task history/output independently
rechecks the lab grant and current project read access. CPU/GPU starts derive their
fleet from the action, reject client fleet overrides, and never provision a VM.

## Semaphore account and project binding

Use a dedicated native account with `task_runner` membership only in the approved
Semaphore project. Do not use an initial administrator password, cloud credentials,
the account of a human administrator, or paid permission features.

Native task execution requires `CanRunProjectTasks`. The pinned
[`environment/{environmentId}` route](https://github.com/semaphoreui/semaphore/blob/v2.20.23/api/router.go)
applies `EnvironmentMiddleware` without the resource-management permission check
previously attributed to it.

Operational verification with a dedicated non-admin bearer confirmed the exact
project membership, HTTP 200 for the effective variable group's metadata, encrypted
key names/types without secret values, and denial of instance-administrator
operations. Private Unix-socket bearer transport was also probed from the published
Bun image. No account identifiers or credentials are needed in this reference.
Keep the native `task_runner` role; no privilege elevation or alternate admin
credential is needed. A denied or malformed response still fails closed rather than
skipping project-binding verification.

For each approved template, the connector verifies:

- Native `app` is `ansible`, project ID matches, the playbook is an exact allowlisted
  path, no alternate working directory is configured, and arguments are empty.
- The native survey has exactly the expected current names, environment targets,
  required/optional flags, types and enum values, with no duplicate or additional
  fields. An optional Create lab cannot have a nonempty default. Missing required
  metadata or conflicting action metadata cannot queue a task. An omitted
  `required` flag is false, matching Semaphore's JSON serialization.
- Exactly one native variable group is selected. Multiple groups fail closed rather
  than guessing effective secret precedence.
- That group's native ID and project match. Its public environment variables contain
  `DEMO_PROJECT_ID` equal to the authorized Recount project and a valid `DEMO_PROJECT`
  label. Ordinary JSON variables cannot shadow either, and the group cannot define
  task survey fields as environment variables, JSON variables or secrets.
- Non-load templates require `DEMO_ENROLLMENT_KEY` as native secret-env metadata.
  Load templates require only the public project-group metadata, not an enrollment
  secret. Public enrollment keys and secret project-label/project-ID overrides are
  rejected for every action.
- Exactly one template matches the requested action and project. Duplicate matching
  copies are ambiguous; display names are never authorization.

Use project-specific List and Destroy templates with the appropriate project group; the empty
bootstrap group is not accepted. Treat approved templates and their project groups
as stable bindings: create a new project-specific template rather than repointing
one with task history.

Semaphore's task API does not supply a historical project-binding attestation.
The toolbar writes a server-generated HMAC scope marker into the native task
`message` field, binding the Recount project, action, template and public survey
inputs. Reads verify this marker as well as the current template/group binding.
Unsigned native tasks, altered inputs and tasks signed for another project/action
are omitted, including after a template is repointed. The marker is never returned
to the browser. The bearer token keys the domain-separated HMAC; rotating the token
hides previously signed tasks from the toolbar. This is scoped metadata, not a
second task store or executor. Only toolbar-initiated tasks can be monitored here;
inspect older native tasks in Semaphore itself.

The server checks the user allowlist and current canonical project access on every
operation. Task reads require project read access; workflow mutations require
project administration. Route context is presentation state, not authorization.
Client input cannot select a template, URL, branch, command, arguments, credentials
or raw environment. Credentials and raw upstream responses remain in `.server.ts`
modules.

## Approved actions

| Action                     | Playbook                     | Public survey inputs                                                                                             |
| -------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Create CPU                 | `infra/demo/create-cpu.yml`  | Optional lab, count 1–200, TTL, fixed `on-demand` and `t4g-nano`                                                 |
| Create GPU                 | `infra/demo/create-gpu.yml`  | Optional lab, count exactly 1, TTL, fixed `spot-only` and `gpu-l4`                                               |
| Configure                  | `infra/demo/configure.yml`   | Existing lab, fleet                                                                                              |
| Move                       | `infra/demo/move.yml`        | Existing lab, fleet, drain or explicitly confirmed queue discard                                                 |
| List                       | `infra/demo/list.yml`        | None                                                                                                             |
| Destroy                    | `infra/demo/destroy.yml`     | Existing lab, fleet, fixed delete confirmation                                                                   |
| Start distributed CPU load | `infra/demo/load-cpu.yml`    | Existing lab, `cpu-hash`/`cpu-primes`/`cpu-pi`, duration 1–300 seconds; fleet fixed to `aws-cpu`                 |
| Start GPU load             | `infra/demo/load-gpu.yml`    | Existing lab, `gpu-fp32`/`gpu-tensor`/`gpu-memory`/`gpu-mixed`, duration 1–300 seconds; fleet fixed to `gcp-gpu` |
| Load status and results    | `infra/demo/load-status.yml` | Existing lab, fleet                                                                                              |
| Stop synthetic load        | `infra/demo/stop-load.yml`   | Existing lab, fleet                                                                                              |

TTL choices are `15m`, `30m`, `1h`, `2h`, `4h`. Lab IDs must match
`[a-z][a-z0-9-]{0,23}`. An omitted Create lab requests Semaphore's automatic ID.
The executor must reject reused manual IDs and enforce the combined runtime cap of
201 (200 CPU, 1 GPU). These caps are not capacity guarantees or launch approvals.
Two hundred CPU nanos require 400 vCPUs before permanent usage; the toolbar neither
changes cloud quotas nor requests quota increases.

Create requires a separate cost confirmation. Destroy and queue discard require
an asynchronous confirmation that stays open while submitting. Configure queues
only its existing-lab playbook, never Create. GPU creation remains disabled unless
explicitly enabled in deployment settings, even after its separate one-L4 Spot
provisioning/enrollment/telemetry/deletion validation. Create and Configure never
start synthetic workloads.

Load starts send only `DEMO_LAB`, `DEMO_WORKLOAD` and `DEMO_DURATION`. Duration is
an integer string from 1 through 300; the UI offers 60, 120, 180 and 300 seconds.
CPU defaults to `cpu-hash`; GPU defaults to `gpu-mixed`. Status and Stop send only
lab and fleet. There is no command, path, worker-count or raw-environment input.

The executor contract requires at least two live nodes for distributed CPU load:
one worker per node, 50% of one CPU core, a 64 MiB cgroup memory cap, one shared
execution/job ID, disjoint shards and reduced results. GPU load targets exactly one
L4 using the installed DCGM proftester, with fixed fields 1007 (FP32), 1004 (tensor)
and 1005 (DRAM), bounded bursts/idle and a host-memory cap. Guest services run
asynchronously so native Stop can execute in the sequential Semaphore project.
The guest hard timeout is at most five minutes, clamped before VM expiry, with no
restart. Stop affects only the named lab's load unit, not collectors or VMs.
These worker and resource controls belong to the native playbooks, not the web
application.

Task submission follows the pinned
[`AddTask`](https://github.com/semaphoreui/semaphore/blob/v2.20.23/api/projects/tasks.go)
contract: POST `tasks` with `template_id` and `environment` as a JSON string
containing only constructed public survey values, plus the server-generated
native `message` scope marker. No automatic task retries or
client-side orchestration queue exists. A failed or malformed POST response is an
uncertain outcome; inspect Semaphore before submitting again.

## Task output and inventory limitations

Recent tasks use `tasks/last?count=30`; task output uses `tasks/{id}/output`.
The panel displays actual upstream status identifiers and locale-formatted dates.
It polls only while Activity is visible, does not poll in the background, isolates Query
keys by user and project, and removes private data on unmount/account changes.
Application authentication also clears the shared QueryClient on identity changes.

Selecting a task opens its output beside the list on wider screens. On mobile it
opens a separate output view with a Back control. The on-demand
`@melloware/react-logviewer` component provides search, line numbers, selection and
virtualized scrolling. It shows the native Ansible transcript by default, with
recognized credential patterns masked and validated results appended. Remote
loading, link detection and global search hotkeys are not enabled. Task links use Semaphore's native
`/project/{id}/history?t={taskId}` route and require the viewer's own Semaphore
sign-in, never the connector token.

Every log fetch requires developer allowlist membership, project access and a
verified task binding. The response is private and not cacheable. Redaction is
defense in depth, not a substitute for Ansible `no_log`; do not print secrets
from playbooks. Structured results are extracted from full-line native debug
JSON key/value records with optional surrounding whitespace:

```text
"msg": "RECOUNT_PUBLIC_CREATE <canonical base64>"
"msg": "RECOUNT_PUBLIC_LOAD <canonical base64>"
```

Only syntactically valid SGR colour sequences are stripped. Cursor-control
sequences, OSC, backspaces, partial escapes, arbitrary prefixes/suffixes, noncanonical
base64 and invalid UTF-8/JSON are rejected. Decoded payloads are capped at 65,536
bytes. Unknown object fields are rejected at every level. Accepted records are
reserialized as JSON rather than showing the original encoded record.

`RECOUNT_PUBLIC_CREATE` is accepted only for Create CPU/GPU. The strict payload is
`{lab_id, ttl}`. TTL must match the task's signed survey. An explicit lab must match
exactly; an automatically generated lab must be `demo-` followed by 16 lowercase hex
digits. This payload has no project field: project authority comes from the verified
template/group and task scope marker.

`RECOUNT_PUBLIC_LOAD` is accepted only for the four load actions and follows the
current `recount_demo_load.py` public summary: job/lab/project/fleet/profile/duration,
aggregate state, bounded node checkpoints and CPU-only reduction. Decoded project
must match the currently authorized Recount project, and lab/fleet must match the
task's signed survey. Starts also match the signed profile and cannot exceed the
requested duration; a shorter executor-clamped duration is valid.

Node cardinality, unique names, states, elapsed-time/counter bounds, CPU reduction
totals and pi estimates, GPU profiler fields and exit statuses are validated.
Native task success is not interpreted as job completion. Repeated snapshots may
update one job; conflicting job or generated-lab identities withhold the result.
Without a valid record, the redacted transcript still appears. Current load lab
grants are checked before load output is parsed.

List currently enumerates the entire demo fleet. Its output remains entirely
withheld, even when the native template is project-bound: a project group alone
does not establish per-VM ownership. List has no native output link in the
toolbar and does not fetch raw task output. No VM counts, TTL or fleet ownership
are inferred.
Exposing List requires executor-verified per-project ownership and an agreed
structured inventory contract. Destroy retains its explicit existing-lab grant
and project checks. No infrastructure changes are included with the toolbar.

## Validate

From `apps/web`:

```sh
bun run typecheck
bun test tests/unit/developer-toolbar.test.tsx
node ../../node_modules/@playwright/test/cli.js test --config tests/unit/developer-toolbar.playwright.ts
```

The focused tests use deterministic HTTP response fixtures and exercise anonymous
and ordinary-user rejection, project/source authorization, strict public inputs,
template/group binding, upstream failures, actual status projection, GPU gating,
redaction and developer-only rendering. They do not need Semaphore or cloud
credentials.

Compile catalogs before the browser command with `bun run typecheck` or
`bun run --filter @recount/i18n compile`. Run these sequentially: catalog compilation
rewrites generated message modules. The isolated browser fixture mocks only the
RPC transport; it checks the real toolbar, form, confirmations and task viewer
without a database or external service.
