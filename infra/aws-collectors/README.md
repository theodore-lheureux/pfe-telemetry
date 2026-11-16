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

## Resources and enrollment

The Canonical public SSM parameter selects Ubuntu 24.04 ARM64, checked against
Canonical's AMI owner. Each VM has an encrypted 8-GiB gp3 disk, public IPv4,
IMDSv2 with a one-hop limit, and standard CPU credits to avoid surplus charges.
The launch template tags instances, disks and interfaces on creation. Owned
resources use `project=recount`, `component=collectors`.

There is no SSH key pair or interactive-access configuration. Ingress defaults
to none; `ssh_cidrs` is firewall-only and should remain empty. The runtime role
can retrieve only `/recount/collectors/enrollment` from SSM in Ohio. CD reads
the Canonical public parameter, not the private enrollment value. Provision that
value as a standard `SecureString` after creating the intended project/enrollment
key on Oracle. Never put it in Terraform variables/state, user data or logs.

Cloud-init installs CA certificates, curl and Python's AWS SDK. The root service
verifies the archive checksum and requires one regular ARM64 ELF executable.
Enrollment is fetched through the instance role into root-only `/run` storage,
then removed after `node.json` exists. Node keys and queues persist privately
under `/var/lib/recount-collector`.

The service has a 256-MiB cap on the 512-MiB host. Measure actual memory pressure
before adding workloads. `RestartSec=75` avoids exhausting five starts in five
minutes during temporary bootstrap connectivity failures.

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
with actual subnets, verified endpoints and an approved release checksum, never
an enrollment value. Follow the bootstrap guide's key-rotation procedure.

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
SSM parameter is included. See [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/),
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
```
