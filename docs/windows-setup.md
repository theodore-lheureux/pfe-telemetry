# Windows setup

Run Recount's repository tooling inside Ubuntu on WSL2. Run ordinary applications/tests natively, using reusable Docker backends. The optional lab needs a Linux Ansible control environment; VirtualBox and Docker Desktop run on Windows. Compile Linux applications and test harnesses in WSL on the host. Packaged-runtime gates execute prebuilt artifacts in Docker; runtime images never compile source code.

## Prerequisites

- Install [WSL2 with Ubuntu](https://learn.microsoft.com/en-us/windows/wsl/install), VirtualBox and Docker Desktop on Windows.
- Install the Linux version of [Vagrant inside Ubuntu](https://developer.hashicorp.com/vagrant/docs/other/wsl). If Vagrant is also installed on Windows, use the same version in both installations.
- Install the developer tools listed in the [root README](../README.md#development-setup) inside Ubuntu. Install `build-essential` for host Rust/librdkafka compilation, not in runtime containers. Build artifacts must match Docker's Linux CPU architecture.
- Enable the Ubuntu distribution in Docker Desktop's **Settings > Resources > WSL integration**.

## WSL settings

On Windows 11 22H2 or newer, enable mirrored networking in WSL Settings so Ubuntu can reach VirtualBox's forwarded SSH ports on Windows loopback. Alternatively, add this to `%USERPROFILE%\.wslconfig`, preserving existing settings:

```ini
[wsl2]
networkingMode=mirrored
```

In Ubuntu, enable Linux file permissions on Windows drives by adding or updating this section in `/etc/wsl.conf`. Preserve other sections and any existing mount options:

```ini
[automount]
options=metadata,umask=22,fmask=11
```

Run `wsl --shutdown` from PowerShell to apply the settings, then reopen Ubuntu and Docker Desktop.

Add the following to `~/.bashrc` in Ubuntu and open a new terminal:

```bash
export VAGRANT_WSL_ENABLE_WINDOWS_ACCESS=1
export PATH="$PATH:/mnt/c/Program Files/Oracle/VirtualBox"
```

These settings let Linux Vagrant use Windows VirtualBox and its Windows-side box cache. See [Vagrant's WSL documentation](https://developer.hashicorp.com/vagrant/docs/other/wsl) and [Microsoft's WSL settings](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) for details.

## Run the project

Keep the checkout in the Linux home directory. From Ubuntu:

```bash
git clone https://github.com/theodore-lheureux/pfe-telemetry.git
cd pfe-telemetry
just setup
just build
just typecheck
```

Next follow the [local stack guide](../infra/README.md) to package host-built Linux artifacts and explicitly initialize the selected current-schema instance. Its identity, data-mount and image/schema guards are authoritative; do not replace a missing intended bind mount with a fresh volume or run offset reset as startup recovery. PostgreSQL stores application/credential authority only; authenticated OTLP flows through raw Kafka, the normalizer, normalized Kafka and native ClickHouse ingestion.

After the stack is prepared and its ingestion API is reachable, `just lab setup` prepares optional Ansible dependencies and `just lab up` starts/provisions the separate VM/monitoring lab. Open [Grafana](http://localhost:3003/d/node-exporter-full/node-exporter-full) in a Windows browser. Use `just lab stop` to retain VM disks and monitoring data, and `just local stop` to stop backends without deleting data. Inspect existing VM metadata and UUIDs before any lifecycle operation. A connectivity probe does not prove telemetry acceptance or query visibility.

See [web development](../apps/web/README.md) for SSR, email-code/passkey authentication and EN/FR configuration. Run ordinary applications/tests natively in WSL, with host Node for Playwright and native Bun for web fixtures; packaged-runtime gates remain separate. VS Code's WSL extension can open the Ubuntu checkout with `code .`.

See the [Linux lab guide](../infra/lab/README.md) for workloads, resource settings and other commands.

## Troubleshooting

- **Docker connection fails:** start Docker Desktop and check its Ubuntu WSL integration.
- **Vagrant cannot find VirtualBox:** check `VAGRANT_WSL_ENABLE_WINDOWS_ACCESS` and that `VBoxManage.exe --version` works inside Ubuntu.
- **SSH connection times out:** check mirrored networking and restart WSL after configuration changes.
- **SSH rejects a private key's permissions:** check the `metadata` mount option, then run `chmod 600` on the key named in the error before retrying.

[Ansible's installation requirements](https://docs.ansible.com/projects/ansible/latest/installation_guide/intro_installation.html) describe control-node support. Windows provisioning must be checked on a Windows machine; Linux CI does not exercise this path.
