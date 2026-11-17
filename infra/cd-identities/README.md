# Ingestion CD identity bootstrap

These roots run **locally once**, with the owner's approved AWS and OCI profile
`pfe`. They are never called by GitHub Actions. They create identities and policies,
not the VM, database volume, firewall changes or application deployment.
The infrastructure workflow operates only on `infra/oracle-stack`.

## AWS state identity

`aws/` creates `recount-ingestion-cd` with no console password and one inline
policy. It can list the ingestion state/workspace prefixes, read/write the exact
`oci/ingestion/terraform.tfstate` object, and read/write/delete its `.tflock`.
It cannot delete state, read another root, modify the bucket, or manage IAM.
The inspected bucket uses SSE-S3 AES256, not a customer-managed KMS key, so no
KMS grant is needed. Recheck encryption before bootstrap.

Copy `aws/terraform.tfvars.example` to ignored `aws/terraform.tfvars`, using the
existing bucket/account. Initialize with the existing backend configuration:

```sh
export AWS_PROFILE=pfe
tofu -chdir=infra/cd-identities/aws init -backend-config=../../state-backend/backend.hcl
tofu -chdir=infra/cd-identities/aws plan -out=bootstrap.tfplan
tofu -chdir=infra/cd-identities/aws apply bootstrap.tfplan
```

With collectors disabled, the plan should add only the ingestion user and its
inline policy. Collectors additionally need their runtime role/profile and
dedicated CD policy described below. No OIDC provider is needed. Stop if IAM user/key creation is
denied; do not replace it with an administrator credential or weaken an SCP.

Create the access key separately with AWS CLI so the secret never enters
OpenTofu state. Capture it directly into a mode-0600 file under ignored local
state, then supply it via stdin to `gh secret set`, never arguments or logs.
Use `AWS_STATE_ACCESS_KEY_ID` and `AWS_STATE_SECRET_ACCESS_KEY` in the protected
`ingestion-plan` and `ingestion-infrastructure` environments only. Do not give
the release or application-deployment jobs AWS credentials.

## OCI identity

`oci/` creates a dedicated user/group, public API-key registration, scoped policy
and instance-specific agent dynamic group. Generate the private RSA key outside
OpenTofu, retain it privately, and pass only its public PEM as `public_key`.
Use the tenancy's actual home region for IAM operations. The owner may select
`oci_profile=pfe-api` and `oci_auth=APIKey` in ignored bootstrap configuration.
This tenancy requires an owner-selected `cd_email`; do not invent an address.

The owner-approved CD policy uses standard service families without resource
predicates: `manage instance-family` and `manage virtual-network-family` in the
VM's compartment; `manage volume-family` in the
dedicated project storage compartment; and read-only volume inventory in the
VM's compartment. It grants no identity, group, policy, Vault or object-storage
management. The VM remains where it is and no resource needs retagging.

Residual risk: these credentials can create, modify or delete compute/network resources in the VM compartment and its descendants, and manage project storage, causing cost or data loss beyond this deployment.

Oracle's [Core permissions reference](https://docs.oracle.com/en-us/iaas/Content/Identity/Reference/corepolicyreference.htm)
requires all three permissions for `AttachVolume`: `INSTANCE_ATTACH_VOLUME` on
the instance, `VOLUME_WRITE` on the volume, and `VOLUME_ATTACHMENT_CREATE` for
the attachment. `manage instance-family` includes the instance and attachment
permissions in the VM compartment; project `manage volume-family` supplies the
volume permission across compartments. Root boot-volume inventory is read-only.

The volume uses an Oracle-provided encryption key, not a Vault CMK. Oracle's
[encryption reference](https://docs.oracle.com/en-us/iaas/Content/Block/Concepts/blockvolumeencryption.htm)
documents no additional Vault/key-delegate grant for this paravirtualized
in-transit encryption path. Customer-managed keys would need separate review.

The tagged security-list update succeeded and TCP/443 is now allowed by OCI,
but the second CD apply still denied attachment. The owner chose the broader
service families instead of further tag/ID condition tuning. No documented
non-mutating `AttachVolume` authorization probe is available; read checks and
mocked plans do not prove write authorization. Verify the actual attachment in
a fresh approved CD apply, never a local attach followed by state import.

Oracle documents defined-tag authorization for Compute and Networking without
a general exclusion for default `Oracle-Tags`; the successful security-list
update confirms that path here, but does not prove the instance attach check.

Inspect all current identity memberships/policies and agent configuration first;
reuse existing equivalents rather than duplicating grants. Initialize the root
with the shared S3 backend, review its plan locally, then apply only the approved
identity changes. Neither this root nor its owner credentials belong in CD.
The volume, attachment, backup policy and ingress are applied later by CD.

## Collectors identity

Set `collectors_vpc_id` privately in the AWS bootstrap to enable the second
`recount-collectors-cd` user, its customer-managed policy, and the EC2 runtime
role/profile. The policy uses an Ohio condition, tag-on-create requirements and
owned-resource tag conditions. Role passing and enrollment parameter reads are
limited to the runtime role and exact SSM parameter. CD cannot read enrollment.
The runtime role also receives `AmazonSSMManagedInstanceCore` for Ansible sessions
without inbound ports. A separate inline CD policy permits configuration of only
`recount-collector-transfer-ACCOUNT`, the private SSM file-transfer bucket created
by collectors CD. It grants no object reads or writes. Operator Ansible sessions
use the owner's AWS profile and presigned transfers; the instance role needs no
S3 access. IAM changes remain in this local bootstrap, never in CD.
The enrollment policy explicitly denies parameter reads outside the selected
enrollment ARN: the AWS-managed SSM policy otherwise permits wildcard parameter
reads. Session Manager's agent/control-channel permissions remain available.
The larger collector policy is customer-managed because the 2,048-character
user-inline limit is too small; it remains below the 6,144-character managed
policy limit and is attached only to the dedicated user.

Generate the second user's key outside OpenTofu. Store it only in protected
`collectors-plan` and `collectors-infrastructure` environments as
`AWS_COLLECTORS_ACCESS_KEY_ID` / `AWS_COLLECTORS_SECRET_ACCESS_KEY`, with a separate
shared `PLAN_ENCRYPTION_KEY`. Those credentials can access only
`aws/collectors/terraform.tfstate` and its lock, never the ingestion or bootstrap
states. See [collectors](../aws-collectors/README.md) for the endpoint/release gates.

## GitHub protection and rotation

Plan environments admit same-repository PR merge refs without review; fork PRs
get offline validation only. Apply, release and deployment environments require
owner review, prevent self-review and are restricted to `main`. Terraform,
workflows, composite actions and scripts are executable code with credential
access, so write access to same-repository PR branches remains a trust boundary.

The plan/apply environments receive the scoped AWS key, OCI private key and
`PLAN_ENCRYPTION_KEY` (a separately generated high-entropy secret shared between
them). Store `AWS_ACCOUNT_ID`, `AWS_STATE_BUCKET`, `INGESTION_TFVARS_JSON`,
`OCI_TENANCY_ID`, `OCI_USER_ID` and `OCI_API_KEY_FINGERPRINT` as environment
secrets too, not plain variables: public runner headers log variables before
scripts can register masks. Use the same rule for instance/compartment IDs and
`COLLECTORS_TFVARS_JSON`. Technical selections such as `OCI_INGESTION_ARCH`
may remain variables.
Oracle plan/apply additionally references the existing repository-level
`CLOUDFLARE_API_TOKEN` secret already used by landing deployment. Do not create a
new environment token or alter the landing workflow; only `app.recount.cloud`
and `ingest.recount.cloud` are managed by this infrastructure root. Zone:Read and
DNS:Edit on `recount.cloud` are required; stop and report permission failures.
Only the OCI identity is also needed in `ingestion-deploy`. Do not upload owner
sessions, bootstrap credentials, private keys or raw plans as artifacts.

The CD workflow encrypts saved plans with GPG AES256 and integrity protection.
Only the ciphertext is retained for one day. Apply downloads the same run's
artifact after approval and uses native S3 locking. The bootstrap state objects
are outside the AWS user's allowed prefix.

The public-log helper registers identifier masks before cloud commands, then
buffers the full `-no-color` plan. Runtime identifiers and email-shaped strings
are masked before that plan is printed for review. Apply output uses a limited
JSON summary. The encrypted plan artifact retains the full original values for
private review.

Rotate keys at least every 90 days and immediately on suspected disclosure:
pause CD, create a second scoped key, update every consuming environment via
stdin, verify state locking/OCI access, then deactivate and delete the old key.
OCI rotation uploads the new public key before switching its fingerprint and
private-key secret; remove the old public key only after verification. Maintain
private recovery receipts and never print secrets. Refresh the plan-encryption
secret only when no saved plans are awaiting approval; old plans then require a
new run.
