# Windows setup

This guide runs the whole project on Windows 11: the web application, the ingestion server, and the test environment with its two VMs and Grafana. It starts from a machine with none of the tools installed.

The test environment cannot run from native Windows. Vagrant configures the VMs with Ansible on the host, and Ansible does not support Windows as a control node; `ansible-playbook` fails at startup with `OSError: [WinError 87]`. The repository therefore runs inside Ubuntu on WSL2, while VirtualBox and Docker Desktop run on Windows. VS Code opens the Ubuntu checkout through its WSL extension.

```text
Windows 11
├── VirtualBox            runs the two VMs (pfe-compute-1, pfe-compute-2)
├── Docker Desktop        runs ingestion, Prometheus, and Grafana
├── VS Code + WSL         edits ~/pfe-telemetry inside Ubuntu
└── WSL2: Ubuntu 24.04
    ├── ~/pfe-telemetry   the repository
    └── bun, just, uv, Rust, Vagrant, Ansible (through uv)
```

Vagrant inside Ubuntu drives the Windows VirtualBox installation. Three WSL settings make this work: Windows access for Vagrant, mirrored networking so Ubuntu reaches the VMs' forwarded SSH ports, and file metadata so SSH accepts Vagrant's keys.

Allow about 25 GiB of free disk space and 8 GiB of RAM. The setup takes about an hour, mostly downloads.

## 1. Windows prerequisites

Open PowerShell as your normal user. Each installer shows a Windows administrator prompt.

```powershell
winget install --id Oracle.VirtualBox -e
winget install --id Hashicorp.Vagrant -e
winget install --id Docker.DockerDesktop -e
winget install --id Microsoft.VisualStudioCode -e
winget install --id Git.Git -e
```

The project requires VirtualBox 7.1.4 or newer and Vagrant 2.4.9 or newer in the 2.x series; it was validated with VirtualBox 7.2.20 and Vagrant 2.4.9. The Windows Vagrant installation is not used to run commands, but it provides the shared `%USERPROFILE%\.vagrant.d` directory that Vagrant in WSL uses for boxes and keys. Git for Windows provides the credential manager that Ubuntu reuses for GitHub.

Restart Windows after the installers finish.

VirtualBox runs alongside Docker Desktop's Hyper-V and WSL2 backend. VirtualBox may show a green turtle icon in this mode; the VMs are slower but work. Do not disable Hyper-V or WSL2, because Docker Desktop requires them.

## 2. Install Ubuntu on WSL2

In PowerShell:

```powershell
wsl --install -d Ubuntu-24.04
```

Ubuntu opens and asks for a Linux username and password. The password is not displayed while you type it. Close the window once a prompt such as `name@PC:~$` appears.

Create `%USERPROFILE%\.wslconfig` to enable mirrored networking. With it, `127.0.0.1` in Ubuntu is the Windows loopback interface, where VirtualBox forwards each VM's SSH port.

```powershell
Set-Content -Path "$env:USERPROFILE\.wslconfig" -Value "[wsl2]`nnetworkingMode=mirrored"
wsl --shutdown
```

If `.wslconfig` already exists, add `networkingMode=mirrored` under its `[wsl2]` section instead of replacing the file.

## 3. Connect Docker Desktop to Ubuntu

Start Docker Desktop and wait until it reports that the engine is running. In **Settings → Resources → WSL integration**, enable **Ubuntu-24.04** and select **Apply & restart**.

## 4. Configure Ubuntu

Open Ubuntu from the Start menu, or run `wsl -d Ubuntu-24.04` in PowerShell. Run every command from here on inside Ubuntu.

Enable Linux permissions on Windows drives. SSH rejects private keys readable by other users, and Windows files otherwise appear with mode `0777`.

```bash
sudo tee -a /etc/wsl.conf > /dev/null <<'EOF'

[automount]
options = "metadata,umask=22,fmask=11"
EOF
```

Exit Ubuntu and restart it from PowerShell so the option applies:

```powershell
wsl --terminate Ubuntu-24.04
wsl -d Ubuntu-24.04
```

Install the system packages and Vagrant from HashiCorp's apt repository. The Linux Vagrant version must also be 2.4.9 or newer in the 2.x series.

```bash
sudo apt-get update
sudo apt-get install -y build-essential git curl unzip ca-certificates gnupg pkg-config libssl-dev
curl -fsSL https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt-get update
sudo apt-get install -y vagrant=2.4.9-1
```

Install the project's pinned developer tools: Bun 1.4.2, just 1.58.0, uv 0.12.23, and rustup. rustup installs the Rust toolchain pinned in `rust-toolchain.toml` on first use.

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"
curl -LsSf https://astral.sh/uv/0.12.23/install.sh | sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
mkdir -p ~/.local/bin
curl -fsSL https://just.systems/install.sh | bash -s -- --tag 1.58.0 --to ~/.local/bin
```

Let Vagrant use the Windows VirtualBox installation:

```bash
cat >> ~/.bashrc <<'EOF'

# pfe-telemetry: let Vagrant in WSL use VirtualBox installed on Windows
export VAGRANT_WSL_ENABLE_WINDOWS_ACCESS=1
export PATH="$PATH:/mnt/c/Program Files/Oracle/VirtualBox"
EOF
```

Close the terminal and open a new Ubuntu terminal, then check the tools:

```bash
bun --version
just --version
uv --version
vagrant --version
VBoxManage.exe --version
docker version --format '{{.Server.Version}}'
```

If `docker` cannot connect to `/var/run/docker.sock`, start Docker Desktop, confirm the WSL integration from step 3, and wait about 30 seconds after any WSL restart.

Configure Git for commits and reuse the Windows GitHub credentials:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git config --global credential.helper "/mnt/c/Program\ Files/Git/mingw64/bin/git-credential-manager.exe"
```

## 5. Clone and set up the repository

Clone into the Linux home directory, not under `/mnt/c`. The Linux file system is much faster for Bun, Cargo, and file watching.

```bash
cd ~
git clone https://github.com/theodore-lheureux/pfe-telemetry.git
cd pfe-telemetry
just setup
```

`just setup` installs the locked Bun, uv, and Cargo dependencies, installs the Git hooks, and creates the local `.env` files.

## 6. Open the project in VS Code

In VS Code on Windows, install the **WSL** extension by Microsoft. Run **WSL: Connect to WSL using Distro** from the command palette (`Ctrl+Shift+P`), select **Ubuntu-24.04**, and open `/home/<linux-user>/pfe-telemetry`. Alternatively, run `code .` from the repository in an Ubuntu terminal.

The status bar shows **WSL: Ubuntu-24.04**. Integrated terminals run Bash in Ubuntu from the repository root. Install the workspace's recommended extensions when VS Code offers them; they install on the WSL side.

## 7. Start the test environment

Start Docker Desktop, then run this in a VS Code terminal:

```bash
just env up
```

The first run downloads the `bento/ubuntu-26.04` box, builds the ingestion image, creates both VMs, provisions them with Ansible, and runs the verification tasks. It can take 20 to 30 minutes. It succeeds when both recap lines report `failed=0`:

```text
node1 : ok=6 changed=0 unreachable=0 failed=0 ...
node2 : ok=6 changed=0 unreachable=0 failed=0 ...
```

The private key used before Vagrant replaces it lives in the Windows Vagrant home. If the first run reports `UNPROTECTED PRIVATE KEY FILE`, restrict it and run `up` again:

```bash
chmod 600 "$(wslpath "$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')")"/.vagrant.d/insecure_private_keys/*
just env up
```

Open Grafana in a Windows browser:

<http://localhost:3003/d/node-exporter-full/node-exporter-full>

Select `pfe-compute-1` or `pfe-compute-2` in the **Nodename** list. Generate load to see the graphs change:

```bash
just env workload cpu 30
```

Stop the VMs and containers when you are done. The VM disks are kept, so the next `just env up` takes a few minutes.

```bash
just env stop
```

See [the test environment README](../infra/test-environment/README.md) for the other environment commands.

## 8. Run the web application and ingestion server

These run directly in Ubuntu and do not need the test environment. Use a separate terminal for each.

```bash
just dev
just server
```

The web application is at <http://localhost:3001>. The ingestion server listens on `127.0.0.1:4317`. With mirrored networking, Windows browsers reach both through `localhost`.

## Troubleshooting

| Symptom                                                                       | Cause and fix                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node1: Warning: Connection refused. Retrying...` until timeout               | Ubuntu cannot reach Windows loopback. Check `networkingMode=mirrored` in `%USERPROFILE%\.wslconfig`, run `wsl --shutdown` in PowerShell, then rerun `just env up`.                     |
| `Vagrant is unable to use the VirtualBox provider from the Windows Subsystem` | `VAGRANT_WSL_ENABLE_WINDOWS_ACCESS` is not set. Open a new terminal after editing `~/.bashrc`.                                                                                         |
| `UNPROTECTED PRIVATE KEY FILE` or `Permissions 0777`                          | The `metadata` mount option is missing or the keys were not restricted. Check `/etc/wsl.conf`, restart Ubuntu, and run the `chmod` command from step 7.                                |
| `failed to connect to the docker API at unix:///var/run/docker.sock`          | Docker Desktop is stopped, WSL integration is off, or Docker is still reconnecting after a WSL restart. Wait and retry.                                                                |
| `Confirm node hostname and private address` fails for one node                | The VM was created by an interrupted run and missed its network configuration. Run `just env vagrant reload node1 --provision`, using the failing node's name, then `just env verify`. |
| `ansible-playbook` fails with `OSError: [WinError 87]`                        | The command ran in PowerShell or Git Bash on Windows. Run it in an Ubuntu terminal.                                                                                                    |
| The VMs are very slow                                                         | VirtualBox runs on Hyper-V while Docker Desktop is installed. This is expected. Lower `TEST_ENV_NODE_MEMORY_MB` or close other applications if the host runs out of memory.            |
| Grafana shows a third node named `vagrant`                                    | A VM reported metrics before its hostname was configured. The series stops receiving data and disappears from the list once it falls outside the selected time range.                  |

## Uninstall

Remove the VMs and containers from Ubuntu with `just env destroy`. Remove Ubuntu with `wsl --unregister Ubuntu-24.04` in PowerShell, which deletes the Linux checkout and everything in it. Remove `networkingMode=mirrored` from `%USERPROFILE%\.wslconfig` and run `wsl --shutdown`. Uninstall the Windows applications from **Settings → Apps**. The Vagrant box cache is in `%USERPROFILE%\.vagrant.d`.
