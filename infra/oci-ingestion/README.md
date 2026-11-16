# Oracle ingestion deployment

The existing Oracle VM is referenced by OpenTofu, with state in the existing
[S3 backend](../state-backend/README.md). GitHub Actions builds native Linux
artifacts and prepares approved release activation through OCI Run Command.
The [layout decision](layout.md) records inspected resources, resource caps,
storage limits, TLS, backups and why Semaphore is not needed.

**Identity bootstrap is not an application deployment.** The AWS state user and
policy have been applied, native S3 locking verified with that identity, and
approval-gated GitHub environments configured. OCI bootstrap created the CD user,
API key, group, scoped policies, agent permissions and project compartment.
Live storage grants were narrowed
and confirmed with `oci iam policy get`. The first approved CD apply created
the data volume, backup policy/assignment and DNS records, but attachment and
security-list update failed with authorization errors. The bootstrap policy has
been corrected; a fresh approved CD apply is required to finish those changes.
Certificates and application deployment remain pending.
Trusted host-key verification and read-only guest inspection are complete;
connection details remain ignored. The host has no Docker, Bun or Caddy yet,
and its firewall still rejects HTTPS.

## Reference the existing resources

Copy `terraform.tfvars.example` to ignored `terraform.tfvars` and use the
inspected instance, primary VNIC, subnet, VCN, boot-volume and NSG identifiers.
Leave real addresses and OCIDs out of shared examples. The data sources verify
that the VNIC and boot volume belong to the selected instance and that its
network matches the selected VCN/subnet/NSGs.

The VM, VNIC, subnet and VCN remain referenced, never recreated. After checking
tenancy-wide free capacity and existing firewall rules, `deployment_enabled`
proposes a protected 150-GiB data volume and attachment, a daily backup policy,
and adoption of the selected security list to add TCP/443 while preserving
TCP/22, current ICMP and egress rules. Fill `security_list_id` from inspection.
Review the full real-account plan before apply: no other rule removal or
instance/network replacement is acceptable. Deployment is disabled by default.

The root also manages only the DNS-only A records `app.recount.cloud` and
`ingest.recount.cloud`, both pointing at the inspected VM public IP. It looks up
the active `recount.cloud` zone by name; no zone/account identifier is committed.
The existing landing Worker, apex and other DNS records are outside this root.
The Cloudflare provider is pinned to stable 5.29.0 with a committed lock file.

Both plan/apply jobs reuse the existing repository-level
`secrets.CLOUDFLARE_API_TOKEN`; no environment token is created. This root needs
Zone:Read and DNS:Edit on `recount.cloud`. The provider token input is sensitive
and public-log masking covers the token, runtime zone/account IDs and IPs.
Report authorization failures rather than substituting another credential or
changing the landing workflow.

`ssh_source_cidrs` is separate from public HTTPS. Its default preserves the
inspected public SSH rule; use approved operator CIDRs, or an empty set after
verifying another management path. Storage and backups belong only in the
project `storage_compartment_id`; the VM remains in its existing compartment.
Core write authorization uses supported resource-tag conditions on the selected
VM and security list. Confirm the corrected permissions in the fresh CD apply;
do not broaden root-compartment grants on failure.

After a partial apply, never reuse the old saved plan or reset state. Generate
a new plan against the existing remote state. The targeted read-only recovery
plan showed only the missing attachment and security-list update; storage,
backup and DNS resources must remain preserved. Review the full fresh CD plan
before approving it. A closed TCP/443 does not distinguish a missing OCI rule
from the host firewall or absent Caddy.

CD copies `adoption.tf.example` to ignored `adoption.tf` before planning the
existing security-list import. OpenTofu 1.13.9 crashes when mocked providers
execute imports, so tests exercise the enabled managed configuration without
that runtime adoption file. They do not simulate the import API operation.
Local read-only plans must select the same adoption file.

With valid owner credentials:

```sh
export AWS_PROFILE=pfe
tofu -chdir=infra/oci-ingestion init -backend-config=../state-backend/backend.hcl
tofu -chdir=infra/oci-ingestion plan -lock=false -input=false
```

Local defaults use `SecurityToken`, profile `pfe`, region `ca-montreal-1`;
the owner can select `APIKey` and `pfe-api` privately. CD selects `APIKey` and
the dedicated `recount-deploy` profile.
Only the owner refreshes/authenticates OCI sessions. A plan is read-only and
unlocked; even saving inventory outputs with `apply` writes state and needs
approval. Do not apply or import as part of inspection.

## Workflows and credentials

| Workflow                | Behavior                                                        | Approval boundary                                 |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| `ingestion-infra.yml`   | PR/main-change plans; manual apply of the same run's saved plan | `ingestion-plan`, then `ingestion-infrastructure` |
| `ingestion-release.yml` | Manual native amd64/arm64 builds; immutable per-run bundles     | Publishing uses `ingestion-release` environment   |
| `ingestion-deploy.yml`  | Manual activation of an already published release on `main`     | `ingestion-deploy` environment                    |

Apply, release and deployment environments restrict execution to `main`, require
reviewers and prevent self-review. Plan runs do not require review. Publishing
creates a release/tag and uploading credentials changes secrets: both need
explicit approval. No workflow is dispatched by this task. Runner minutes and
artifact/release storage must fit the owner's approved GitHub allowance.

The apply/release/deploy environments use owner review with self-review disabled.
An initiator cannot approve their own apply. Reviewer approval is separate from
the authorization to push these workflow files; neither is bypassed here.

Release IDs are `COMMIT-RUN-ATTEMPT`. Rust, the web bundle and schema exporter
compile on `ubuntu-24.04` and `ubuntu-24.04-arm` respectively, using locked
dependencies and target-aware staging. Docker packages prebuilt artifacts; it
does not compile application source or use emulation. Existing artifact
validation checks executable architecture and web privacy boundaries. CI also
executes both Rust images' offline help to detect missing runtime libraries.
Both architectures must finish before publication.

Native builds attest final runtime and collector archives with GitHub artifact
attestations. Deployment verifies the repository, expected workflow, `main`,
release commit and hosted-runner identity before computing the receiver digest.
VM-side hashing remains mandatory. GitHub attestation OIDC does not require an
AWS IAM OIDC provider.

Bundles include tagged ingestion/normalizer/web images, the schema image and
explicit runtime configuration files. They exclude private environment files,
source workspaces, cloud credentials and databases. The existing GitHub
repository must remain **public** for anonymous VM downloads; deployment refuses
a private repository. A private registry/transfer path would need a separate
approved design, not a token embedded in the VM command.

Packaging rejects images above a combined 4-GiB unpacked budget or a download
above 2 GiB, keeping the receiver's staging allowance bounded.

Set environment variables after approval:

| Environment                  | Variables                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ingestion-deploy`, secrets  | `OCI_INSTANCE_ID`, `OCI_COMPARTMENT_ID`, `OCI_TENANCY_ID`, `OCI_USER_ID`, `OCI_API_KEY_FINGERPRINT`, `OCI_API_PRIVATE_KEY` |
| `ingestion-deploy`, variable | `OCI_INGESTION_ARCH=arm64`                                                                                                 |

`OCI_COMPARTMENT_ID` selects the isolated project compartment where commands are
stored, not the root compartment containing the VM. Creation remains
exact-VM-conditioned; status reads need a separate target-conditioned execution
family grant in the VM compartment. Both operations were verified live with a
harmless command under the dedicated CD identity.

Infrastructure changes run through `ingestion-infra.yml`. Plan runs for
same-repository PRs and relevant `main` changes; fork PRs get offline checks only.
Apply is manual on `main`, after approval in `ingestion-infrastructure`.
All runs share a concurrency group and native S3 locks. Apply uses the exact
encrypted plan from the same run; stale state fails rather than silently re-planning.

The repository's Actions logs are public. Cloud identifiers and tfvars JSON are
environment secrets so runner headers are masked from the first step. The
shared public-log helper additionally masks nested values and email-shaped
strings, buffers the full `-no-color` plan, and prints it only after redacting
runtime identifiers and emails. Apply logs use a limited JSON summary and emit
redacted provider error summaries/details when an operation fails.
Imported Oracle provenance tags
remain ignored by lifecycle configuration, but state and full plans still
contain them; only the encrypted plan artifact is uploaded. Existing published
run logs are not retroactively redacted by these changes.

The [bootstrap roots](../ingestion-bootstrap/README.md) run locally once with
AWS/OCI profile `pfe` to create identities, policies and public keys. They are
excluded from CD. CI's AWS user can access only ingestion state and its lock,
not bootstrap state or IAM. Local commands are for offline checks and read-only
inspection:

```sh
just --justfile infra/oci-ingestion/justfile check
just --justfile infra/oci-ingestion/justfile plan
```

GitHub uses a dedicated OCI user and API key, never the owner's session or an
administrator key. The private key lives in the protected `ingestion-deploy`
environment secret. The runner writes mode-0600 files and removes them on
completion. Rotate/revoke the key through the owner-managed process; no private
key belongs in OpenTofu state or release artifacts.

Application release activation needs only `INSTANCE_AGENT_COMMAND_CREATE` and
`INSTANCE_AGENT_COMMAND_EXECUTION_INSPECT` for the selected instance. Infrastructure
CD also needs the managed storage, backup and security-list permissions in the
bootstrap guide. Neither may manage IAM. Anonymous
public-release downloads need no additional OCI transfer permissions. The agent's
dynamic group must include only the existing VM and have command-execution
permission for itself. Before creating any policy, verify that Run Command
authorization supports the required one-instance restriction. The VM is in the
root compartment; a compartment-wide policy is not acceptable isolation.

See Oracle's [Run Command prerequisites](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/runningcommands.htm)
and [command permissions](https://docs.oracle.com/en-us/iaas/Content/Identity/Reference/corepolicyreference.htm).
The dedicated identity's command creation and successful status retrieval were
verified on the Ubuntu VM. The deployment receiver and its restricted sudo rule
remain uninstalled and untested.

## Prepare the host after approval

These are live changes. Do not perform them until the owner approves the host
setup, credentials, IAM, TLS/ingress and storage/backups plan.

1. Inspect guest software, workloads, disk usage and firewall through an
   explicitly configured SSH host/key. Reuse installed Docker/Compose, Bun and
   proxy where appropriate; approve any installation separately. The host needs
   GNU coreutils, Bash, curl, tar, gzip and `flock`. It needs neither a compiler
   nor an Actions runner.
2. Provision root-owned `/opt/recount/releases` and `/etc/recount`. Download one
   approved ARM64 bundle, verify its published SHA-256, and inspect it. Install
   its `backend/` and `backend.SHA256SUMS` under `/opt/recount/` exactly once.
   Verify the manifest from `/opt/recount/backend`. Do not overwrite a running
   backend with a later release.
3. Prepare root-owned mode-0600 `/etc/recount/ingestion.env`, following
   `infra/local/.env.example` but using privately provisioned runtime credentials.
   Use `COMPOSE_PROJECT_NAME=recount-ingestion`; point
   `RECOUNT_SCHEMA_DIRECTORY` to `/opt/recount/backend/schema` and
   `RECOUNT_CLICKHOUSE_IMAGE` to the approved bundle's `recount-clickhouse:RELEASE`.
   Select `data.binds.yaml`, set the three data directories on the verified
   mounted block filesystem, and include the deployment overlay for raised caps.
   Record the selected mount directory and filesystem UUID as two lines in
   root-owned mode-0600 `/etc/recount/data-mount`. Activation checks that exact
   filesystem before allowing any database startup.
   Keep defaults for topics, limits and ports. Create independent runtime roles
   for web and ingestion; do not give web the PostgreSQL bootstrap credential.
   The deployment overlay fixes `BETTER_AUTH_URL=https://app.recount.cloud`.
   Configure matching signing/public keys and SMTP privately.
4. Only for this explicitly approved new instance, load the bundle images and
   follow [explicit initialization](../README.md#initialize-an-isolated-current-schema-instance).
   Run native initialization helpers from an approved matching source checkout
   with the backend, data-bind and deployment overlays selected and the
   root-only environment selected. Initialize each empty named volume once,
   record all three database identities, create/verify topics, apply the
   committed Drizzle migrations with a schema-management credential, and grant
   the restricted runtime roles. Nothing in ordinary release activation
   initializes data, migrates databases, creates topics or seeds checkpoints.
5. After confirming those migrations were applied from the release commit,
   install its `migrations.sha256` as
   `/etc/recount/approved-migrations.sha256`. This is an explicit operator receipt,
   not proof obtained from the database. Never copy the receipt before applying
   the migrations.
6. Install the reviewed `deploy/receive.sh` as root-owned mode-0755
   `/usr/local/sbin/recount-release`. Put the exact public `owner/repository` in
   root-owned `/etc/recount/repository`. Review `deploy/sudoers`, validate it
   with `visudo -cf`, then install it root-owned mode-0440 under `/etc/sudoers.d/`.
   Keep `ocarun` out of the Docker group and never grant `NOPASSWD:ALL`.
   All receiver/config/release parent directories must be writable only by root.
7. Configure the host proxy using `deploy/Caddyfile`: it serves exactly
   `app.recount.cloud` and `ingest.recount.cloud` using Let's Encrypt
   TLS-ALPN-01 on 443. No port 80 is needed. Mount the approved
   data volume and confirm backup eligibility before initialization.

Docker's existing `unless-stopped` policy restores initialized backend/application
containers after reboot. Compose is sufficient; no extra systemd controller,
Ansible service or Semaphore dependency is introduced.

## Activate and verify

After explicit deployment approval, dispatch `Deploy ingestion release` with
the approved release ID. It submits only the fixed receiver command with
validated ID/architecture/checksum arguments, then waits for terminal execution
success **and exit code zero**. API acceptance is not deployment success.

The receiver checks architecture, free staging space plus a 30% disk reserve,
SHA-256, backend/schema manifest equality, migration receipt and initialized
database identities. It verifies topics, loads images and updates only
ingestion, normalizer, Live and web with `--no-deps --pull never`; it never
restarts shared backends. A backend/schema change fails for separate maintenance
review instead of replacing mounted schemas under running consumers.

After health checks, inspect normalizer assignment, independent native consumer
lag and a synthetic authorized collector-to-query round trip. Test HTTPS gRPC,
auth/passkeys, SSE and proxy forwarding through the real hostnames. Container
health alone does not prove freshness, completeness or capacity.

Failure leaves staged releases and data intact. There is no automatic cleanup,
rollback or retry of an uncertain remote command. Inspect OCI execution status
and the host first; failed activation can leave some application containers
updated. Reactivating an older application is safe only after checking its
schema compatibility. Never roll back the database or delete volumes to make
an old image start.

## Offline checks

```sh
just --justfile infra/oci-ingestion/justfile check
```

This includes the infrastructure roots, enabled-path provider mocks, collector retry
configuration, deployment helpers, workflow linting and security checks.
Mocks never contact AWS/OCI. Keep real identifiers/backend configuration ignored.
Ansible syntax checks do not apply: this deployment adds no playbooks.
