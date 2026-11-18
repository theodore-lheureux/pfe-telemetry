# Oracle stack deployment

The existing Oracle VM is referenced by OpenTofu, with state in the existing
[S3 backend](../state-backend/README.md). GitHub Actions builds native Linux
artifacts, and an approved deployment activates a release with Ansible over SSH.
The [layout decision](layout.md) records inspected resources, resource caps,
storage limits, TLS, backups and why Semaphore is not needed.

**Identity bootstrap is not an application deployment.** The AWS state user and
policy have been applied, native S3 locking verified with that identity, and
approval-gated GitHub environments configured. OCI bootstrap created the CD user,
API key, group, scoped policies and project compartment.
Live storage grants were narrowed
and confirmed with `oci iam policy get`. Infrastructure CD has applied the data
volume and attachment, backup policy/assignment, DNS and OCI TCP/443 rule.
Application activation remains a separate CD operation. The
[host bootstrap playbook](ansible/bootstrap.yml) prepares the runtime, persistent
data mount, initialized backends, application authority and HTTPS proxy.
Connection details and private configuration remain ignored.

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
The owner approved broad compute/network service-family access in the VM
compartment, with storage management in the project compartment.
Identity/policy management remains excluded; see the bootstrap guide's risk note.

After a partial apply, never reuse the old saved plan or reset state. Generate
a new plan against the existing remote state. The targeted read-only recovery
plan initially showed the missing attachment and security-list update; the 443
rule is now applied. Storage, backup and DNS resources must remain preserved.
Review the full fresh CD plan
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
tofu -chdir=infra/oracle-stack init -backend-config=../state-backend/backend.hcl
tofu -chdir=infra/oracle-stack plan -lock=false -input=false
```

Local defaults use `SecurityToken`, profile `pfe`, region `ca-montreal-1`;
the owner can select `APIKey` and `pfe-api` privately. CD selects `APIKey` and
the dedicated `recount-deploy` profile.
Only the owner refreshes/authenticates OCI sessions. A plan is read-only and
unlocked; even saving inventory outputs with `apply` writes state and needs
approval. Do not apply or import as part of inspection.

## Workflows and credentials

| Workflow           | Behavior                                                        | Approval boundary                                 |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------------- |
| `infra-oracle.yml` | PR/main-change plans; manual apply of the same run's saved plan | `ingestion-plan`, then `ingestion-infrastructure` |
| `release.yml`      | Native amd64/arm64 builds on every push to `main`, then deploy  | `ingestion-deploy` environment                    |

Apply and deployment environments restrict execution to `main` and require the
owner's review. Plan runs do not require review. Deploys do not wait for the test
workflows. Publishing a prerelease, which collectors and demo VMs install from,
runs beside the deploy without approval and never blocks it.

Release IDs are `COMMIT-RUN-ATTEMPT`. Rust, the web bundle and schema exporter
compile on `ubuntu-24.04` and `ubuntu-24.04-arm` respectively, using locked
dependencies and target-aware staging. Docker packages prebuilt artifacts; it
does not compile application source or use emulation. Existing artifact
validation checks executable architecture and web privacy boundaries. CI also
executes both Rust images' offline help to detect missing runtime libraries.
Both architectures must finish before publication.

Native builds attest final runtime and collector archives with GitHub artifact
attestations. Deployment verifies the repository, expected workflow, `main`,
release commit and hosted-runner identity before computing the archive digest.
The VM-side download verifies that digest. GitHub attestation OIDC does not require an
AWS IAM OIDC provider.

Bundles include tagged ingestion/normalizer/web images, the schema image and
explicit runtime configuration files. They exclude private environment files,
source workspaces, cloud credentials and databases. The existing GitHub
repository must remain **public** for anonymous VM downloads; deployment refuses
a private repository. A private registry/transfer path would need a separate
approved design, not a token placed on the VM.

Packaging rejects images above a combined 4-GiB unpacked budget or a download
above 2 GiB, keeping the release staging allowance bounded.

Set the deploy environment after approval:

| Environment                  | Values                                             |
| ---------------------------- | -------------------------------------------------- |
| `ingestion-deploy`, secrets  | `DEPLOY_SSH_PRIVATE_KEY`, `DEPLOY_SSH_KNOWN_HOSTS` |
| `ingestion-deploy`, variable | `OCI_INGESTION_ARCH=arm64`                         |

Infrastructure changes run through `infra-oracle.yml`. Plan runs for
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

The [bootstrap roots](../cd-identities/README.md) run locally once with
AWS/OCI profile `pfe` to create identities, policies and public keys. They are
excluded from CD. CI's AWS user can access only ingestion state and its lock,
not bootstrap state or IAM. Local commands are for offline checks and read-only
inspection:

```sh
just --justfile infra/oracle-stack/justfile check
just --justfile infra/oracle-stack/justfile plan
```

Infrastructure CD uses a dedicated OCI user and API key, never the owner's
session or an administrator key. Its private key lives in the protected
`ingestion-infrastructure` and `ingestion-plan` environments; the runner writes
mode-0600 files and removes them on completion. The policy grants compute,
network and project-storage service families but no IAM administration. The VM
is in the root compartment, so the CD key has broad compute/network authority
there.

Release deployment uses SSH, not the OCI API. The protected `ingestion-deploy`
environment holds only `DEPLOY_SSH_PRIVATE_KEY`, a dedicated ed25519 key for the
`recount-deploy` user, and `DEPLOY_SSH_KNOWN_HOSTS`, the VM's pinned host key for
`app.recount.cloud`. Rotate the deploy key by generating a new pair, updating
`recount_deploy_public_key` in the private inventory, rerunning the `system`
tag and replacing the secret.

## Prepare the host after approval

These are live changes. Do not perform them until the owner approves the host
setup, credentials, IAM, TLS/ingress and storage/backups plan.

OpenTofu/CD owns cloud resources, DNS and IAM. Ansible owns host preparation over
verified SSH as `ubuntu`, using the owner's existing key. Deploy CD owns only
application release activation.

1. Verify the SSH host key through trusted OCI output, then pin it in an ignored
   known-hosts file. Inspect guest workloads, disk identity and signatures before
   selecting the data volume. Confirm backup eligibility separately.
2. Prepare an ignored inventory and private SMTP input using the
   [bootstrap inputs](#bootstrap-inputs). Verify the published ARM64 archive's
   GitHub attestation using the same repository/workflow/main/commit constraints
   as release CD, then select its SHA-256. The controller checkout's Drizzle
   history, runner and lockfile must match that release commit.
3. Run from the repository root:

   ```sh
   ANSIBLE_CONFIG=infra/oracle-stack/ansible/ansible.cfg \
     uv run ansible-playbook \
       -i infra/oracle-stack/.state/ansible/inventory.json \
       infra/oracle-stack/ansible/bootstrap.yml --syntax-check
   ANSIBLE_CONFIG=infra/oracle-stack/ansible/ansible.cfg \
     uv run ansible-playbook \
       -i infra/oracle-stack/.state/ansible/inventory.json \
       infra/oracle-stack/ansible/bootstrap.yml
   ```

4. Run the playbook again and require `changed=0`. Verify the UUID-backed mount
   and `/etc/fstab`, backend health, runtime role restrictions, the deploy
   user's single authorized key, and TLS certificates through both real hostnames. Do not dispatch
   application deployment until these checks pass.

The playbook installs Ubuntu's Docker and Caddy packages plus checksum-pinned
native Compose and Bun binaries. Compose must preserve explicit false bind
options in `config --format json`; Ubuntu's older package omits them and fails
the existing [data-selection guard](../local/data.ts). The playbook preserves
Oracle firewall rules and adds only TCP/443.
It formats only an explicitly approved, signature-free 150-GiB disk with the
selected serial, mounts by UUID, and requires that mount before Docker starts.
The root-only `/etc/recount/data-mount` records the identity checked by activation.

The approved release is unpacked under `/opt/recount/bootstrap`, not the
deployment's `/opt/recount/releases` directory. Its backend is installed once and
verified on every run; a changed manifest fails rather than replacing it.
Private runtime credentials and matching Ed25519 signing/public keys are created
once in root-owned mode-0600 `/etc/recount/ingestion.env`. Web uses `recount_web`,
not the PostgreSQL bootstrap account; ingestion receives the existing SELECT-only
grants. Sign-up remains disabled.

Activation appends `/etc/recount/web.local.yaml` when it exists. This optional
root-owned mode-0600 Compose overlay holds host-specific `web` settings, such as
the [developer toolbar](../../docs/developer-toolbar.md) socket mount and settings file.

Explicit initialization reuses the existing empty-data helpers, records all
three database identities and creates topics only on an empty broker. Partial
data without a recorded identity fails for inspection; reruns never reset it.
The controller bundles the existing Drizzle runner, and the host verifies the
copied migration history against the release checksum before applying it.
`approved-migrations.sha256` is written only after migrations and runtime grants
succeed. This remains an operator receipt, not database-derived proof.

No application container is started and `/opt/recount/current` is not changed.
Ordinary activation never initializes databases, creates topics or migrates.

Docker's existing `unless-stopped` policy restores initialized backend/application
containers after reboot. Compose is sufficient; no extra systemd controller,
Ansible service or Semaphore dependency is introduced.

### Bootstrap inputs

Keep inventory, known hosts, generated runner and SMTP input under ignored
`.state/ansible/` with private directory/file permissions. The inventory must
select exactly the approved host in group `recount_ingestion` and set:

| Variable                                    | Value                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ansible_host`, `ansible_user`              | Verified VM address and `ubuntu`                                                                                |
| `ansible_ssh_private_key_file`              | Owner's existing private key path                                                                               |
| `ansible_ssh_common_args`                   | `-o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=...`                 |
| `recount_data_device`                       | Stable `/dev/disk/by-id/` path of the inspected data disk                                                       |
| `recount_expected_data_serial`              | Independently inspected disk serial                                                                             |
| `recount_data_mount`                        | Approved absolute data mount directory                                                                          |
| `recount_repository`                        | Exact public GitHub `owner/repository`                                                                          |
| `recount_release`, `recount_release_sha256` | Approved release ID and attested ARM64 archive digest                                                           |
| `recount_smtp_file`                         | Controller path to private JSON containing `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` |
| `recount_initialize_data_volume`            | Explicit `true` only for approved first formatting                                                              |
| `recount_initialize_backends`               | Explicit `true` only for approved first initialization/migrations                                               |

Unset the two initialization approvals after successful preparation. Keep
credentials out of command arguments, inventory examples and logs. Bootstrap
never rotates existing runtime secrets; later credential or backend changes
require separate maintenance.

## Deployment user

The `system` tag creates `recount-deploy` with exactly one authorized key,
`recount_deploy_public_key` from the private inventory, and a validated
passwordless sudo rule, because Ansible activation needs privilege escalation.
Only the protected deploy environment holds the matching private key, and every
deployment requires its approval.

```sh
ANSIBLE_CONFIG=infra/oracle-stack/ansible/ansible.cfg \
  uv run ansible-playbook \
    -i infra/oracle-stack/.state/ansible/inventory.json \
    infra/oracle-stack/ansible/bootstrap.yml --tags system
```

## Activate and verify

Each push to `main` runs `Release · build and deploy`, whose deploy job waits for
approval in the `ingestion-deploy` environment. The runner verifies the build
attestation of that run's archive against this repository's release workflow on
`main`, computes its SHA-256, then runs `ansible/deploy.yml` over SSH as
`recount-deploy`. The playbook checks that the release matches the VM's
architecture, uploads the archive and checks its digest, checks its embedded
release identity and runs the archive's `activate.sh`. To roll back, re-run the
deploy job of an earlier run while its artifacts are retained (7 days).

Releases ship only the web, ingestion API and normalizer images, compressed
with zstd. Bootstrap builds the ClickHouse image on the host from the pinned
upstream image and the release's schema files.

Activation checks free space plus a 30% disk reserve, backend/schema manifest
equality, the migration receipt and initialized database identities. It
verifies topics, loads images and updates only the ingestion API, normalizer,
Live and web with `--no-deps --pull never`; it never restarts shared backends. A
backend/schema change fails for separate maintenance review instead of replacing
mounted schemas under running consumers.

After health checks, inspect normalizer assignment, independent native consumer
lag and a synthetic authorized collector-to-query round trip. Test HTTPS gRPC,
auth/passkeys, SSE and proxy forwarding through the real hostnames. Container
health alone does not prove freshness, completeness or capacity.

### View ingestion health

Release activation starts a separate Grafana, Prometheus and Kafka exporter
Compose project. It does not restart Kafka or ClickHouse to enable monitoring.
Only Grafana publishes a port, bound to Oracle's loopback interface. Open an SSH
forward using an authorized operator account:

```sh
ssh -N -L 127.0.0.1:3303:127.0.0.1:3003 <oracle-ssh-host>
```

Open [Recount ingestion health](http://127.0.0.1:3303/d/recount-ingestion).
The dashboard shows arrivals, committed progress and lag by stage and partition.
If raw lag rises, investigate the normalizer. If raw lag stays low but normalized
or late lag rises, investigate the corresponding ClickHouse consumer. An absent
series is unknown, not zero. The lag counts are neutral; use the backlog growth
trend and retained offset headroom to tell whether a queue needs attention.

A host timer samples ClickHouse CPU throttling, data-volume request latency and
server-wide read latency and failures. These reads include monitoring and are
not specific to dashboards. The points-written panel counts rows in new
ClickHouse parts, excluding merges but including possible replays; Kafka rates
count messages instead. Neither measures collector-to-query freshness, which
requires an authorized end-to-end probe.

Failure leaves staged releases and data intact. There is no automatic cleanup
or rollback. Read the Ansible output in the workflow log and inspect the host;
failed activation can leave some application containers updated. Reactivating an older application is safe only after checking its
schema compatibility. Never roll back the database or delete volumes to make
an old image start.

## Offline checks

```sh
just --justfile infra/oracle-stack/justfile check
```

This includes the infrastructure roots, enabled-path provider mocks, collector retry
configuration, deployment helpers, workflow linting and security checks.
Mocks never contact AWS/OCI. Ansible syntax checks and synthetic runtime
configuration tests do not change the host or start containers. Keep real
identifiers, inventory and backend configuration ignored.
