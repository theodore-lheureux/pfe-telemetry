# Temporary-demo Semaphore

Semaphore runs separately on the existing Oracle VM and controls
[temporary AWS CPU and GCP GPU collectors](../demo/README.md).
OpenTofu owns VM/disk lifecycle; Ansible owns OS, collector/DCGM configuration and
project re-enrollment. Permanent Oracle/AWS deployment workflows are unchanged.

## Create collectors

1. At [Recount](https://app.recount.cloud/), create/select a project and create an
   enrollment key under Collectors. Copy the project UUID from its URL.
2. As the Semaphore project administrator, create a native **Variable Group**.
   Set its environment variables to
   `{"DEMO_PROJECT":"lab","DEMO_PROJECT_ID":"<project UUID>"}`.
   Use a lowercase label of at most 24 letters, digits or hyphens.
3. Add **DEMO_ENROLLMENT_KEY** as a native **secret environment variable**.
   Do not use ordinary JSON variables, plain environment variables, surveys or
   CLI arguments for the key. Native secrets are encrypted in SQLite.
4. Clone **Create CPU collectors**, **Create GPU collectors**, **Configure
   collectors** or **Move collectors**, name the copy after the project and select
   only that project's group. Release 2.20.23 selects groups in the template
   editor, not the Run dialog.
5. Run the template with bounded count/TTL, preset and explicit cost confirmation.
   Leave the lab ID blank to generate a unique ID, or enter a new one.
   Copy the ID from the task output for later operations.
   Use **List collectors** and **Destroy lab** for existing labs.

Synthetic loads are separate explicit workflows, not Create/Configure switches:
**Start distributed CPU load**, **Start GPU load**, **Load status and results**
and **Stop synthetic load**. Select the lab's project group and follow the
[profile, duration and resource limits](../demo/README.md#synthetic-loads).

Any number of Recount projects may have groups/template copies. No host project
map, Recount administrator password, database credential or project-creation API
key is supplied to the runner. Keys reach Ansible only; OpenTofu subprocesses
explicitly remove the enrollment variable and use public-only input files.

Before provisioning or configuration, Ansible selects the newest published `release-*`
runtime build with the target architecture's archive and checksum and verifies
its GitHub attestation against the main-branch release workflow and source commit.
These runtime builds are published as prereleases; drafts and unrelated tags
are excluded. A failed artifact check creates no VM.

Alex and Simeon are separate local `task_runner` members; the administrator manages
groups/templates. Project managers can edit executable templates and must be treated
as code-execution principals. Form limits are not IAM quotas against managers.
Scoped cloud IAM, isolated networks and dedicated mounts remain authoritative.

## Cloud prerequisites

The [private configuration example](demo-config.example.yml) selects allocations,
not user-controlled cloud IDs or resource paths.

- **GCP GPU:** fixed `recount-cloud` project and `recount-demo` VPC/tag. Pre-create
  the selected subnet and SSH firewall allowing only Oracle's public IPv4 `/32`.
  Use scoped external-account WIF; attach no service account to GPU VMs.
- **AWS CPU:** pre-create an isolated tagged subnet/SG, a new provisioner role,
  and a new node SSM profile. The base federation signer keeps its EC2 deny and
  assumes only the exact demo provisioner role. Use its `recount-demo` AWS profile
  for the AWS provider/SSM; S3 state and GCP WIF keep the base identity.
- **AWS SSM:** a separate private unversioned transfer bucket with encryption,
  block-public-access and short object lifecycle. Never use the versioned state
  bucket. The node profile needs SSM channels, not `GetParameter*` or Secrets Manager.
  If an existing startup association updates the agent, set
  `aws.startup_ssm_document: AWS-UpdateSSMAgent`. Configuration waits for its
  successful execution and a connected agent before recording an enrollment attempt.
- **AWS expiry:** install and verify the independent [expiry Lambda/rule](../demo/expiry/aws/)
  before setting `aws.expiry_guard_ready: true` and `aws.enabled: true`.
  Runtime roles must not manage expiry IAM/Lambda/rules.
- **State:** allow only `demo/labs/*` objects and locks. Bucket listing must be
  restricted to that prefix. Use encryption, `use_lockfile=true`,
  `workspace_key_prefix=demo/labs/workspaces` and the default workspace.

AWS runtime needs scoped instance/image/subnet/SG/status/Spot reads,
`RunInstances`/`CreateTags` under the demo on-demand/request-tag/type/network conditions,
tag-qualified `TerminateInstances`, and `iam:PassRole` only for the new node role.
The AWS provider also needs `ModifyInstanceAttribute` for
shutdown behavior, restricted to the same owned demo tags, with
`ec2:Attribute = InstanceInitiatedShutdownBehavior` and
`ec2:Attribute/InstanceInitiatedShutdownBehavior = terminate`.
SSM needs sessions only on demo nodes and its selected session document, plus
tag-qualified `GetConnectionStatus` and `DescribeInstanceAssociationsStatus`
reads and required temporary-bucket object access. No owner/CD identity, network/IAM
mutation, permanent node credentials or permanent state is allowed.

CPU defaults are small. The ceiling of 200 requires a private administrator
approval setting, sufficient on-demand vCPU quota and a cost review; no quota is
requested automatically. Public IPv4 and individual boot disks add costs.
Private mode only selects explicitly prepared NAT-reachable subnets.

## Private inputs

Run preparation with an ignored variables file selecting `semaphore_private_source`,
`semaphore_access_team`, `semaphore_access_audience` and `semaphore_tunnel_id`:

```sh
uv run --locked ansible-playbook -i localhost, infra/semaphore/prepare.yml \
  --extra-vars @/selected/private/semaphore-prepare.yml
```

Preparation retains established passwords/encryption keys. Place known initial
passwords in their files before running it. Complete:

```text
access-key
bootstrap/{admin,alex,simeon}-password
bootstrap/accounts.json            # accounts.example.json with real emails
runner/config.json                 # generated once
demo/config.yml                    # selected allocations and small default budgets
demo/federation-aws.json            # base AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_REGION
demo/external-account.json         # GCP external_account WIF configuration
demo/aws-config                    # profile below; no owner profile
tunnel/config.yml                  # generated Access audience enforcement
tunnel/credentials.json            # existing dedicated tunnel runtime credential
```

```ini
[profile recount-demo]
role_arn = <new scoped demo provisioner role ARN>
credential_source = Environment
region = <selected region>
# external_id = <only when required by the role trust>
```

Supply the dedicated GCP guest Ed25519 private/public key paths separately.
The runner reads only those files, not host home, Oracle credentials, production
data/sockets, CI keys or permanent cloud profiles. Its entrypoint loads base
signing secrets from a private JSON file, not Docker `Config.Env`.

## Install on Oracle

Use a source archive containing only this directory and `infra/demo`, including
committed provider lock files but excluding caches/private inputs. New source
need not be published on GitHub. Build/deployment uses that exact archive, never
missing files on public `main`.

```sh
uv run --locked ansible-playbook -i /selected/private/oracle-inventory.yml \
  infra/semaphore/deploy.yml --extra-vars @/selected/private/semaphore-deploy.yml
```

The private variables select `semaphore_source_bundle`, its
`semaphore_source_sha256`, `semaphore_private_source`, `semaphore_runtime_subnet`,
`semaphore_admin_email`, `semaphore_demo_ssh_private_key_source` and
`semaphore_demo_ssh_public_key_source`. Inventory group `semaphore` uses trusted
non-root SSH, strict known-host checking and externally supplied become credentials.

The playbook creates only `/opt/recount-demo-semaphore` and two owned systemd
units. It builds a native ARM64 image from pinned official Semaphore/SDK images,
a checksum-pinned OpenTofu release, hash-locked Ansible/Boto3 and pinned GitHub CLI/SSM tools.
No Rust or web build runs. Native API bootstrap creates ten Ansible templates,
separate accounts and one Community global local-executor runner.
Existing credentials, variable groups and template edits are retained.

## Host isolation and persistence

Compose project `recount-demo-semaphore` publishes only `127.0.0.1:3100`.
Its dedicated cloudflared container reaches `http://semaphore:3000` over the
private bridge and [requires Access JWT audience validation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/#access).
Keep the existing Access allowlist limited to Theodore, Alex and Simeon.
The HTTPS webroot enables Secure cookies; local authentication stays separate.
Production Caddy, port 443 and production Compose projects are unchanged.

Containers are non-root, unprivileged, capability-dropped, read-only and resource/
log bounded. Owned source-scoped firewall chains block metadata, new host
connections and private networks outside this bridge. No global chain is flushed.
IPv6 is disabled. Systemd applies the guard before starting these containers;
Docker auto-restart is disabled to avoid a boot-time bypass. Verify the installed
Docker firewall backend before exposing the tunnel.

Named volumes retain [SQLite/configuration](https://docs.semaphoreui.com/administration-guide/installation/docker/),
encryption/cookie keys, runner data and operation receipts. Back them up with
private inputs; do not remove volumes on redeploy. No startup resets data or
overwrites established secrets.
