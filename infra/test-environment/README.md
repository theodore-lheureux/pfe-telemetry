# Local test environment

Two Ubuntu 26.04 VMs run with Vagrant and VirtualBox. The [Tonic ingestion server](../../apps/server/README.md), Prometheus, and Grafana run in Docker Compose. The guests have independent Linux kernels and a private network. Grafana displays guest system metrics collected by Alloy. The Rust server exposes standard gRPC health checks; telemetry exports remain unimplemented until a durable sink is configured.

## Setup

Run `just setup` at the repository root to install the locked Ansible tooling and copy missing `.env` examples. Install Vagrant 2.4.9 or newer in the 2.x series, VirtualBox 7.1.4 or newer for your CPU architecture, and Docker with a local engine and Compose 2.20 or newer. Put their commands on `PATH`; the environment recipes also include VirtualBox's standard macOS installation directory.

Allow roughly 20 GiB for the box cache and two disks, plus the monitoring images and data. Each VM defaults to 1 CPU and 1024 MiB of RAM. The ingestion container is limited to 0.25 CPU and 128 MiB, Prometheus to 0.25 CPU and 256 MiB, and Grafana to 1 CPU and 1 GiB, in addition to Docker Desktop's own VM. The first run needs internet access to download images, build Rust dependencies, and install missing guest packages.

The configuration pins `bento/ubuntu-26.04` to `202606.01.0` and selects the host architecture automatically. The command recipes require Bash. Native Windows use is unverified.

## Commands

From the repository root:

```sh
just env                  # List commands
just env up               # Start ingestion, provision the VMs, verify both
just env verify           # Check hostname, private address, agents, and connectivity
just env check            # Simulate configuration changes and run connectivity checks
just env inventory --graph
just env provision        # Reapply Ansible and verify
just env status
just env stop             # Halt the VMs and stop ingestion, retaining disks
just env destroy          # Vagrant asks before deleting the VM disks
```

The recipes run Vagrant through `uv run`, using the project's locked Ansible installation and Python interpreter. Ansible installs the guest packages, a pinned gRPC health probe for x86-64 or ARM64 with a download checksum, and Alloy through the official `grafana.grafana.alloy` role bundled with Ansible. After both VMs are ready, `up` and `provision` run the `verify` tasks in the site playbook. These check each host's configured hostname and private address, its gRPC connection to ingestion, private connectivity to the other members of the `compute` inventory group, Alloy readiness, and its connection to Prometheus.

The local `compute` group follows Vagrant's default SSH host-key policy for these disposable localhost VMs. Host-key checking is disabled, and `UserKnownHostsFile=/dev/null` keeps their changing host keys out of the developer's personal SSH records. SSH authentication uses Vagrant's generated private keys.

Use native tool options through these recipes:

```sh
just env vagrant ssh node1
just env vagrant provision node1 --provision-with ansible
just env compose logs ingestion
just env validate         # Validate Vagrant and Compose without starting them
just check-environment   # Check Ruby, Ansible, and Compose definitions
```

If startup fails partway through, inspect `status` and the native error output, then retry `up` or run `stop`. Start Docker Desktop and wait for its engine before running `up`.

## Ansible structure

```text
ansible/
  ansible.cfg
  group_vars/compute.yml
  site.yml
  tasks/verify.yml
  workload.yml
  files/sequential-write.fio
  templates/node-metrics.alloy.j2
```

Vagrant generates the local inventory at `.vagrant/provisioners/ansible/inventory/vagrant_ansible_inventory`. It contains the current SSH ports and private-key paths, the `compute` group, each host's hostname and private IP, and the ingestion and Prometheus addresses. The node definitions in the Vagrantfile supply VM settings and inventory host variables from the same map. Generated connection settings stay outside Git.

`ansible.cfg` selects this inventory and treats unreadable inventories or unmatched host patterns as errors. Vagrant selects the configuration through `config_file`; the environment recipes set `ANSIBLE_CONFIG`. Shared package settings, probe versions, interpreter selection, and SSH policy live in `group_vars/compute.yml`. Ansible loads these variables beside the playbooks. The inventory command uses `--playbook-dir ansible` to load them too.

The site playbook statically imports the connectivity tasks with `never` and `verify` tags. Default provisioning skips them so the first VM can provision before its peers start. `just env verify` selects them explicitly; `just env check` uses `--check --diff --tags all,verify` to simulate provisioning and run the read-only probes. Check mode requires already-provisioned VMs because it does not install missing tools. A successful check-mode run can report configuration changes that would still need to be applied.

## Storage and local settings

VirtualBox uses its normal user registry and default machine folder. To store new VM disks on another drive, change the Default Machine Folder in VirtualBox's preferences before creating them. This preference is local to each developer's machine.

Changing the default folder affects new VMs. Move existing powered-off VMs with VirtualBox's `movevm` command. The Vagrant box cache is stored separately under `~/.vagrant.d/boxes`.

Keep `.vagrant` and the VM files while the VMs exist. `.state` stores workload results. Stop the VMs before ejecting a drive that holds their disks or box cache. Commands can run through `just env vagrant` or directly with `uv run --project ../.. --locked vagrant` from this directory.

The local `.env` also controls `TEST_ENV_HOST_PORT`, `TEST_ENV_PROMETHEUS_PORT`, `TEST_ENV_GRAFANA_PORT`, `TEST_ENV_NODE_CPUS`, and `TEST_ENV_NODE_MEMORY_MB`. Stop the environment before changing these values. Exported environment variables override `.env`. CPU and memory settings should be recorded with later performance experiments.

## Networking

| Component        | Identity                                  | Address                                       |
| ---------------- | ----------------------------------------- | --------------------------------------------- |
| VM 1             | Vagrant `node1`, hostname `pfe-compute-1` | `192.168.56.11`                               |
| VM 2             | Vagrant `node2`, hostname `pfe-compute-2` | `192.168.56.12`                               |
| Ingestion server | Compose service `ingestion`               | Host `127.0.0.1:8088`, guests `10.0.2.2:8088` |
| Prometheus       | Compose service `prometheus`              | Host `127.0.0.1:9090`, guests `10.0.2.2:9090` |
| Grafana          | Compose service `grafana`                 | Host `127.0.0.1:3003`                         |

The two private addresses use an internal VirtualBox network, with no bridge to the LAN. The host reaches the guests through Vagrant SSH. Each guest also has a NAT interface; `nat-localhostreachable` lets `10.0.2.2` reach host loopback services. The repository and host home are not mounted in the guests.

VM names use the `pfe-telemetry-test` prefix. The internal network and Compose project are named `pfe-telemetry-test`. Use one active checkout per host. The ingestion server binds to host loopback and uses plaintext gRPC without authentication. Named health checks verify process connectivity; overall and OTLP readiness remain `NOT_SERVING` until ingestion is implemented.

## VM interfaces and monitoring

VirtualBox Manager lists the VMs and provides their consoles. They run headlessly by default and contain Ubuntu Server, so their consoles show a terminal. Use `just env vagrant ssh node1` or `node2` for an SSH session.

After `just env up`, open [Grafana](http://localhost:3003/d/node-exporter-full/node-exporter-full). The provisioned Node Exporter Full dashboard shows CPU, memory, filesystems, disk I/O, network traffic, and system load. Select `pfe-compute-1` or `pfe-compute-2` with the dashboard's host selector. It defaults to the last 15 minutes and refreshes every five seconds. The local interface grants anonymous viewer access and binds to host loopback.

Alloy 1.20.1 runs inside each guest. Its embedded Node Exporter collects Linux metrics every five seconds and forwards them through Prometheus remote write to `10.0.2.2`. Prometheus 3.15.0 stores them locally; Grafana 13.2.3 queries it over the Compose network. These tools provide test-environment monitoring independently of the Rust collector and ingestion server. Metrics describe each guest's kernel and virtual devices; physical host temperature and hardware performance counters may be unavailable.

Prometheus and Grafana use named Docker volumes. `stop` and `destroy` retain these volumes. Prometheus retains up to six hours of samples with a 256 MiB retention target; its active head and write-ahead log can exceed that size. To delete monitoring history and Grafana state after stopping the environment, run `just env compose down --volumes`.

The vendored dashboard is [Node Exporter Full, ID 1860, revision 45](https://grafana.com/grafana/dashboards/1860-node-exporter-full/), licensed under Apache 2.0. Its UID, default data source, time range, and refresh interval are configured for this environment. The dashboard's license is included beside its JSON file.

To watch a workload change the charts:

```sh
just env workload cpu 60 node1
just env workload memory 60 node2 -e pfe_memory_mb=256
just env workload io 60 node2
```

## Workloads

Provisioning installs stress-ng and fio. Workloads run separately after the VMs have started:

```sh
just env workload                     # CPU, 10 seconds, both nodes
just env workload cpu 10 all
just env workload memory 20 node1
just env workload io 10 node2
just env workload memory 20 all -e pfe_memory_mb=128 -e pfe_workers=2
```

The CPU scenario uses stress-ng's `sqrt` method. The memory scenario uses its `vm` workers with 64 MiB total by default. The I/O scenario uses the versioned [sequential-write profile](ansible/files/sequential-write.fio): synchronous direct writes with 64 KiB blocks and a 64 MiB file per worker by default. stress-ng produces load and diagnostic statistics; its operation counts are not precise benchmark scores.

Runs default to one worker per node and accept 1-300 seconds, 1-4 workers, up to 256 MiB of memory, and up to 256 MiB of I/O files per node. Set `pfe_workers`, `pfe_memory_mb`, or `pfe_io_mb` with Ansible's `-e` option. The node selector accepts inventory names and Ansible limit patterns.

Ansible starts the selected nodes' commands asynchronously, waits for completion, and fetches their output. Runs can overlap; starts are not synchronized. Use separate terminals and node selectors to overlap different scenarios. Workloads run as the SSH user.

Each run creates an ignored directory under `infra/test-environment/.state/results`, with one directory per node. `run.json` records the parameters, exact command, tool version, node resources, and process result. Tool output is saved as `result.yaml` for stress-ng or `result.json` for fio; I/O runs also archive the `.fio` profile. Completed runs remove their guest files and async job records. Failed runs retain any available output and their failure details locally.

Grafana shows the resulting node-level resource usage. The ingestion scaffold does not record workload metrics or associate executions with these measurements. These scenarios exercise resources on the selected nodes; distributed application behavior needs a separate workload.

`just dev` starts the web application independently of the test environment.

## References

- [Vagrant setup and architecture selection](https://developer.hashicorp.com/vagrant/tutorials/get-started/setup-project)
- [VirtualBox networking](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/networkingdetails.html)
- [VirtualBox storage preferences](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/Troubleshooting.html)
- [Vagrant issue with inaccessible unrelated VMs](https://github.com/hashicorp/vagrant/issues/13741)
- [just modules](https://just.systems/man/en/modules.html)
- [Vagrant generated inventory and host variables](https://developer.hashicorp.com/vagrant/docs/provisioning/ansible_intro#auto-generated-inventory)
- [Ansible inventory variables](https://docs.ansible.com/projects/ansible/latest/inventory_guide/intro_inventory.html#organizing-host-and-group-variables)
- [Ansible tags](https://docs.ansible.com/projects/ansible/latest/playbook_guide/playbooks_tags.html)
- [Official Alloy Ansible role](https://grafana.com/docs/alloy/latest/set-up/install/ansible/)
- [Linux monitoring with Alloy](https://grafana.com/docs/alloy/latest/monitor/monitor-linux/)
- [Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/)
- [Ansible asynchronous execution](https://docs.ansible.com/projects/ansible/latest/playbook_guide/playbooks_async.html)
- [stress-ng](https://github.com/ColinIanKing/stress-ng)
- [fio job files and options](https://fio.readthedocs.io/en/latest/fio_doc.html)
