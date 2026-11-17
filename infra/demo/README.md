# Demo collectors

Temporary collectors on Google Cloud for tests and demos, with optional NVIDIA
GPU telemetry. Each VM is a Spot instance that Google deletes at its expiry, so
a forgotten demo cannot keep billing. The permanent AWS collectors are managed
separately by [their OpenTofu root](../aws-collectors/README.md).

## Prerequisites

- `gcloud` signed in with access to the `recount-cloud` project (override with
  `RECOUNT_DEMO_GCP_PROJECT`).
- `gh` signed in, to find the latest `release-*` build.
- `~/.ssh/id_ed25519`, installed on each VM for the `recount` user.
- `uv sync --locked` for the repository's Ansible.

## Use

Create an enrollment key in the target project (project → Collectors → new
key), then store it under the project's name. Keys stay in the ignored
`infra/demo/.state/keys/` directory:

```sh
pbpaste | just demo key "GPU demo"
```

Start, inspect, move and remove collectors:

```sh
just demo up --project "GPU demo" --gpu --load --ttl 2h
just demo up --project "Lab" --count 2 --ttl 1h
just demo list
just demo move demo-gpu-demo-gpu-123450 --project "Lab"
just demo down --all
```

| Option    | Effect                                                                                   |
| --------- | ---------------------------------------------------------------------------------------- |
| `--gpu`   | Spot `g2-standard-4` with one L4, or `n1-standard-4` with a T4 when L4s are out of stock |
| `--load`  | With `--gpu`, cycles tensor, FP16 and FP32 load; each cycle is a labelled execution      |
| `--ttl`   | Hard expiry, such as `90m` or `4h` (default `2h`)                                        |
| `--count` | Number of collectors to start                                                            |

Without `--gpu`, collectors run on Spot `e2-small` VMs. `move` stops the
collector, deletes its node identity and queue, and enrolls it with the other
project's key; the old node stays in the first project as an inactive node with
its history.

The first SSH connection is verified against the host key the VM publishes
through Compute Engine guest attributes. The playbook installs the collector
from the latest release after checking its published SHA-256, and removes the
enrollment key from the VM once the node is enrolled.
