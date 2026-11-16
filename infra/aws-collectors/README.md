# AWS collectors

Two `t4g.nano` collectors run in existing public Ohio subnets. State uses
`aws/collectors/terraform.tfstate` in the existing S3 bucket with native locking.
No collector VM has been applied.

## Deployment gates

Do not apply this root until an authorized point is accepted over Oracle HTTPS
and becomes queryable. The current collector supports verified HTTPS OTLP
natively; use a release built from the current code and approved by attestation.
Keep `oracle_endpoint_verified` false until the actual Oracle check passes.
Do not downgrade transport or add a proxy workaround.

The endpoint defaults are `https://ingest.recount.cloud` for OTLP/gRPC and
`https://app.recount.cloud` for enrollment. Both resolve directly to the Oracle
VM through DNS-only records; Cloudflare does not proxy collector traffic.

## Resources and enrollment

The Canonical public SSM parameter selects Ubuntu 24.04 ARM64, checked against
Canonical's AMI owner. Each VM has an encrypted 8-GiB gp3 disk, public IPv4,
IMDSv2 with a one-hop limit, and standard CPU credits to avoid surplus charges.
The launch template tags instances, disks and interfaces on creation. Owned
resources use `project=recount`, `component=collectors`.

There is no SSH key pair or inbound access. Ansible uses
`amazon.aws.aws_ssm` sessions with the owner's AWS profile. The runtime role has
`AmazonSSMManagedInstanceCore` and can retrieve only the application parameter
`/recount/collectors/enrollment` from SSM in Ohio. CD reads
the Canonical public parameter, not the private enrollment value. Provision that
value as a standard `SecureString` after creating the intended project/enrollment
key on Oracle. Never put it in Terraform variables/state, user data or logs.

Cloud-init prepares only the SSM agent, CA certificates, curl and Python needed
for the Ansible connection. It installs no collector and contains no application
configuration or enrollment value.

The [collector playbook](ansible/collector.yml) installs the selected release and
systemd service. Installation verifies the archive checksum and requires one
regular ARM64 ELF executable. The running service never downloads or replaces its
binary. At service start, enrollment is fetched through the instance role into
root-only `/run` storage, then removed after `node.json` exists. Node keys and
queues persist privately under `/var/lib/recount-collector`; reruns and release
updates never reset them.

The service has a 256-MiB cap on the 512-MiB host. Measure actual memory pressure
before adding workloads. `RestartSec=75` avoids exhausting five starts in five
minutes during temporary enrollment connectivity failures.

### Production organization and enrollment

The [operator provisioning script](../../apps/web/scripts/provision-collector-project.ts)
uses the application's Better Auth adapter and server-only organization API,
then the existing authorized project and enrollment-key domains. It creates
canonical owner membership, not a parallel access table. A missing account is
created with `emailVerified: false`; existing verification state is preserved.
The script neither issues sessions nor consumes or sends sign-in codes.
The owner verifies their address through normal email-code sign-in.

Run this only through an approved host connection against the selected private
environment. The JSON stdin supplies `email`, `organizationName`,
`organizationSlug`, `projectName` and a root-only `stateDirectory`. The CLI takes
`DATABASE_URL`, `BETTER_AUTH_URL` and `BETTER_AUTH_SECRET` from the host's existing
environment and connects through PostgreSQL loopback. It returns only resource
identifiers and keeps the once-revealed key in `stateDirectory/enrollment.key`.
A missing or mismatched saved key fails instead of silently rotating it.
The local lab's separate provisioning script remains loopback-only.

Bundle on the controller, not on the VM:

```sh
bun build apps/web/scripts/provision-collector-project.ts --target=bun \
  --external '#tanstack-*' --external 'tanstack-start-manifest:*' \
  --outfile=infra/aws-collectors/.state/provision-collector-project.mjs
```

Transfer the reviewed bundle over the verified Oracle host connection. Run it
with the root-only host environment and private stdin, never email arguments.
Transfer the saved enrollment key directly into the standard Ohio SSM
`SecureString` using the owner's `pfe` credentials on the controller. Do not put
owner AWS credentials on Oracle, copy the key into Terraform, or print it.
The production organization is `Recount`, with project `AWS collectors` and a
two-active-node enrollment limit. A bounded native HTTPS probe verified accepted
points in that project; its temporary node was revoked and hidden while its
telemetry was retained.

### Ansible over SSM

The approved identity bootstrap attaches the SSM managed-instance policy and
grants CD configuration access to exactly its transfer bucket. CD creates that
bucket with the VMs. It blocks all public access, enforces bucket ownership and
TLS, uses SSE-S3, disables versioning, and expires interrupted transfers after one
day. The plugin deletes successful transfers. Instance roles need no S3 grant:
the plugin uses short-lived presigned URLs from the controller's credentials.
Enrollment values are fetched on each instance, never transferred through S3.

Install the AWS Session Manager plugin on the controller and use
`uv sync --locked` for the repository's Ansible and boto3 dependencies. Keep a
private `infra/aws-collectors/.state/ansible-vars.json` containing:

- `recount_transfer_bucket`: the `ansible_transfer_bucket` OpenTofu output.
- `recount_collector_release_url`: the approved public ARM64 collector archive.
- `recount_collector_release_sha256`: its attested SHA-256.

After the owner pushes and approves infrastructure CD apply:

```sh
AWS_PROFILE=pfe \
  ANSIBLE_CONFIG=infra/aws-collectors/ansible/ansible.cfg \
  uv run --locked ansible-playbook \
    -i infra/aws-collectors/ansible/aws_ec2.yml \
    -e @infra/aws-collectors/.state/ansible-vars.json \
    infra/aws-collectors/ansible/collector.yml
```

The dynamic inventory selects only running Ohio instances tagged
`project=recount`, `component=collectors`; the playbook requires exactly two.
Allow time for their SSM agents to register. Run again to verify `changed=0`,
then verify both node identities and recent project points through the production
application/ClickHouse. A service's active state alone does not prove delivery.

## CD and identity

The local [AWS bootstrap](../ingestion-bootstrap/README.md) creates the separate
`recount-collectors-cd` user/policy and runtime role/profile. CD cannot manage
IAM; role passing and profile reads are restricted to that runtime identity.
EC2 mutations require Ohio and owned project/component tags; creation requires
those tags. Launches also require Canonical's image, the selected VPC,
`t4g.nano`, IMDSv2 and encrypted gp3 no larger than 8 GiB.

`collectors-infra.yml` plans on same-repository PRs/main changes. Apply is manual
on `main` with approval in `collectors-infrastructure`, using the same run's
encrypted plan. Runs share a concurrency group and native S3 locks. Fork PRs get
offline checks only. Bootstrap never runs in CD.

Only `collectors-plan` and `collectors-infrastructure` receive the environment
secrets `AWS_COLLECTORS_ACCESS_KEY_ID`, `AWS_COLLECTORS_SECRET_ACCESS_KEY`,
`PLAN_ENCRYPTION_KEY`, `AWS_ACCOUNT_ID`, `AWS_STATE_BUCKET` and
`COLLECTORS_TFVARS_JSON`. Use `terraform.tfvars.example` for the latter,
with the account, VPC, two public subnets and verified Oracle gate, never an
enrollment value. Release and endpoint configuration belong to Ansible, not
OpenTofu or cloud-init. Follow the bootstrap guide's key-rotation procedure.

Until `COLLECTORS_TFVARS_JSON` is configured, the plan finishes with a skip
notice: it does not initialize OpenTofu, upload an artifact or enable apply.
Public logs retain the full plan with identifiers and runtime emails redacted.

The native release workflow publishes collector archives and attestations.
Verify the collector attestation against this repository, release workflow,
`main` and release commit before approving its checksum in CD variables.

## Cost estimate

At 730 hours per month:

| Item                                            | Monthly estimate (USD) |
| ----------------------------------------------- | ---------------------: |
| Two Linux `t4g.nano`, $0.0042/hour each         |                   6.13 |
| Two 8-GiB gp3 disks, $0.08/GiB-month            |                   1.28 |
| Two public IPv4 addresses, $0.005/hour each     |                   7.30 |
| Total before transfer, taxes and other services |              **14.71** |

The compute rate was checked with AWS Price List for Ohio on 16 November 2026.
This is an on-demand estimate, not an Always Free claim or spending cap. No NAT
gateway, load balancer, reserved commitment, cross-region backup or advanced
SSM parameter is included. S3 transfer storage and request charges are additional.
See [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/),
[EBS pricing](https://aws.amazon.com/ebs/pricing/) and
[public IPv4 pricing](https://aws.amazon.com/vpc/pricing/).

After approved CD apply, verify that both enrolled node IDs publish points to
the intended ClickHouse project. Instance health, systemd status or enrollment
alone does not establish end-to-end collection. Never create VMs just to debug
a non-live Oracle endpoint.

## Checks

```sh
tofu -chdir=infra/aws-collectors init -backend=false -input=false
tofu -chdir=infra/aws-collectors fmt -check -recursive
tofu -chdir=infra/aws-collectors validate
tofu -chdir=infra/aws-collectors test
python3 -m unittest discover -s infra/aws-collectors -p 'test_*.py'
actionlint .github/workflows/collectors-infra.yml
ANSIBLE_CONFIG=infra/aws-collectors/ansible/ansible.cfg \
  uv run --locked ansible-playbook --syntax-check \
    -i recount_collectors, infra/aws-collectors/ansible/collector.yml
```
