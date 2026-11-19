# Temporary collectors

OpenTofu owns temporary VMs and their boot disks. Ansible installs collectors,
configures GPU telemetry and moves enrolled nodes between Recount projects.
[Semaphore](../semaphore/README.md) runs the same Ansible playbooks from browser forms.
Permanent [AWS collectors](../aws-collectors/README.md) and the
[Oracle application](../oracle-stack/README.md) retain their own workflows.

| Fleet   | VM                            | Collector                  | Boot disk                                    | Expiry                                         |
| ------- | ----------------------------- | -------------------------- | -------------------------------------------- | ---------------------------------------------- |
| AWS CPU | On-demand `t4g.nano`, 512 MiB | ARM64, 256 MiB service cap | Independent encrypted 8 GiB gp3, auto-delete | Absolute launch tag, independent cloud cleanup |
| GCP GPU | Spot `g2-standard-4`, one L4  | AMD64 with DCGM            | Independent 60 GiB, auto-delete              | Native `maxRunDuration` and `DELETE`           |

Each VM has its own writable GNU/Linux boot disk. Only the immutable base image
is shared. No shared filesystem, RAM-only image, Beszel or Alloy agent is installed.
Markets are fixed: AWS CPU is on-demand and GCP GPU is Spot. There is no market or shape fallback.

## Run a lab

Leave the lab ID blank on Create to generate a unique `demo-*` ID, shown in task
output, or supply a new lowercase ID of at most 24 letters, digits or hyphens,
starting with a letter. Existing-lab operations require that lab's ID.
Creation requires a project UUID, label and enrollment key from a native
encrypted Semaphore variable group. The [browser procedure](../semaphore/README.md#create-collectors)
keeps keys out of surveys, Terraform variables, state and user data.

For local execution, use the same worker image with explicit private mounts.
The thin recipes call these playbooks:

```sh
just demo cpu
just demo gpu
just demo list
just demo configure
just demo move
just demo destroy
```

Inputs are `DEMO_LAB`, `DEMO_COUNT`, `DEMO_TTL`, `DEMO_PRESET`, and explicit
`DEMO_COST=on-demand` for CPU or `DEMO_COST=spot-only` for GPU. Existing-lab actions also select `DEMO_FLEET=aws-cpu` or
`gcp-gpu`. Configuration/movement use `DEMO_PROJECT`, `DEMO_PROJECT_ID` and native
secret-env `DEMO_ENROLLMENT_KEY`; destruction requires `DEMO_CONFIRM=delete`.
Do not place secrets in a shell command or CLI argument.

CPU defaults to two VMs with an administrator fleet budget of three. The
configuration ceiling is 200, not an automatic launch or quota increase.
Budgets above five require `large_fleet_approved: true` in private administrator
configuration. GPU count is always one globally. Requested TTL is 15 minutes–4 hours.
Public mode bills one public IPv4 and one boot volume per VM in addition to compute.
Private mode requires explicitly allocated subnets with working NAT/SSM/S3/HTTPS
reachability; it creates no network resources or Oracle ingress changes.

## State and expiry

The two roots use separate default-workspace S3 keys:

```text
demo/labs/aws-cpu/<lab-id>/terraform.tfstate
demo/labs/gcp-gpu/<lab-id>/terraform.tfstate
```

S3 encryption and native lock files are required. The runtime identity must not
access permanent state. A successful `tofu state pull` with no resources, outputs
or history identifies a new key; existing state or a retained local claim prevents another Create, even after
expiry. Configure, List and Move never apply infrastructure or recreate missing VMs.
Destroy validates state identities, checks live replacements and accounts for all
live lab VMs before deletion. Unknown or untracked instances require reconciliation,
not a blind retry. State is retained after destruction so the lab ID remains used.

The [AWS expiry root](expiry/aws/) is installed separately with trusted bootstrap
credentials. One small Lambda runs every five minutes and terminates explicit,
expired demo CPU IDs only after checking ownership, shape, network and profile.
Its IAM policy also requires the demo ownership tags. Launch tags contain a fixed
absolute expiry; cleanup caps lifetime at four hours from launch. Schedule/control
plane latency is additional to requested TTL. Guest shutdown is not the expiry
guarantee. Verify cleanup and permanent-instance exclusion before enabling CPU creation.

Package its standard-library handler before applying the trusted root:

```sh
python3 -m zipfile -c /selected/artifacts/recount-demo-expiry.zip infra/demo/expiry/aws/handler.py
```

The archive contains `handler.py` at its root. Supply the absolute archive path as `package_path`.
The runtime runner cannot manage this Lambda, its rule or IAM roles.

## Configuration and movement

AWS uses a new scoped `recount-demo` role/profile and Ansible SSM, with a separate
private **unversioned** transfer bucket. The node profile grants SSM channels only,
not Parameter Store, Secrets Manager or permanent collector credentials.
GCP uses a dedicated guest SSH key and guest-published host-key verification;
its VMs have no service account or scopes.

Public release artifacts are checked against SHA-256 and GitHub build provenance.
Ansible selects ARM64 for AWS CPU and AMD64 for GCP GPU. Sampling starts only after
`node.json.projectId` matches the selected project. The enrollment key is copied
to a mode-0600 temporary guest file and removed in `always`. An unreachable host
cannot run cleanup; its private file remains bounded by VM expiry.

Move stops and disables sampling/workload before touching identity. A private
snapshot protects the old queue while `--drain` runs. Expiry, rejection, participant
rejection or incomplete delivery restores that snapshot; acknowledged batches may
replay, but undelivered telemetry is retained. Only successful delivery or explicit
`DEMO_DISCARD=discard-old-queue` permits clearing old identity/queue. Failed or
interrupted movement requires receipt reconciliation before retrying. The old
node is not revoked; its history remains and it becomes inactive after heartbeat expiry.

Failed setup retains the lab state/receipts and cloud expiry. Destroy that exact
lab explicitly; do not reapply it or reset shared state.

## Synthetic loads

Create and Configure install/enroll collectors but do not start synthetic work.
Run loads explicitly on an existing lab with the same project variable group:

1. Use **Start distributed CPU load** on a lab with at least two CPU nodes, or
   **Start GPU load** on the single GPU node.
2. Supply the existing lab ID, a profile and a maximum duration. The form offers
   60, 120, 180 or 300 seconds; the executor also accepts shorter positive durations
   for checks. A job cannot extend past the earliest node's expiry.
3. Start returns after dispatch, leaving the Semaphore queue available.
   **Load status and results** reads checkpoints and reduces the distributed
   results. Select the existing lab and fleet.
4. **Stop synthetic load** stops only that lab's worker unit and retains its partial
   counters. It does not stop the collector or delete a VM. Stop a running job
   before starting another.

| Profile      | Work                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------- |
| `cpu-hash`   | SHA-256 work on disjoint nonce blocks; reduce operation counts, matches and an XOR checksum |
| `cpu-primes` | Search disjoint integer ranges; reduce candidate counts, prime counts and prime sums        |
| `cpu-pi`     | Independent deterministic Monte Carlo blocks; reduce sample/hit counts and estimate pi      |
| `gpu-fp32`   | DCGM profiler FP32 pipe, field 1007                                                         |
| `gpu-tensor` | DCGM profiler tensor pipe, field 1004                                                       |
| `gpu-memory` | DCGM profiler DRAM activity, field 1005                                                     |
| `gpu-mixed`  | Alternate FP32, tensor and memory bursts                                                    |

CPU nodes share one job/execution ID and receive non-overlapping numbered blocks.
The coordinator dispatches shards and reduces their checkpoints over the existing
SSM/SSH connections. No worker-to-worker ports, coordinator VM or extra service is
created. This is a distributed compute job, not a network-throughput benchmark.
Missing or interrupted shards produce a partial result, never a completed reduction.
A GPU burst cut short by its duration limit is reported as interrupted; successful
earlier bursts remain counted. A stopped or interrupted profiler is not reported
as completed computation.

Each nano runs one standard-library Python worker, limited to 50% of one CPU core,
64 MiB of resident memory and no swap. Burst-credit exhaustion can reduce observed
CPU utilization. No RAM-filling stress, numerical framework or dataset download is
required. GPU profiles reuse the installed `dcgmproftester` with up to five-second
bursts and matching idle periods. The GPU worker has a 1-GiB host-memory cap;
profiler GPU buffers are managed by DCGM, not that host cgroup.

Guest systemd units have an independent runtime limit, no automatic restart,
control-group termination and a VM-expiry deadline. Status verifies the current
guest project and recorded instance identities before reading at most 8 KiB per
checkpoint. Job plans and reduced results remain in private lab receipts.

The native survey inputs are `DEMO_WORKLOAD` and `DEMO_DURATION`. Existing-lab
operations still require `DEMO_LAB`; status/stop also select `DEMO_FLEET`.
The local equivalents are `just demo load-cpu`, `load-gpu`, `load-status` and
`stop-load`, using the same environment inputs and private worker mounts.
