# Ingestion CD identity bootstrap

These roots run **locally once**, with the owner's approved AWS and OCI profile
`pfe`. They are never called by GitHub Actions. They create identities and policies,
not the VM, database volume, firewall changes or application deployment.
The infrastructure workflow operates only on `infra/oci-ingestion`.

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
tofu -chdir=infra/ingestion-bootstrap/aws init -backend-config=../../state-backend/backend.hcl
tofu -chdir=infra/ingestion-bootstrap/aws plan -out=bootstrap.tfplan
tofu -chdir=infra/ingestion-bootstrap/aws apply bootstrap.tfplan
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

The root creates a dedicated `recount-ingestion-data` compartment. Volume and
backup management is granted only there; the VM remains in its original
compartment. Root-compartment attachment management is conditioned on that VM.
Selected security-list changes and Run Command are also target-conditioned.
The principal has read-only inventory access in the VM's compartment, but no
unconditional root-compartment storage management, IAM or object-storage access.
Release downloads are public.

Commands are stored in the project compartment and may be created only for the
selected VM. Command metadata reads stay in that compartment. Execution-family
reads in the VM compartment are separately target-conditioned; live testing
showed that a command-read grant alone could not read execution status.
Creation and successful execution inspection have both been verified.
The boot-volume inventory grant permits only the `GetBootVolume` operation;
root-compartment data-volume listing was denied in a live negative check.

**Validate target-condition support with real requests.** The OCI
reference does not establish all instance/security-list target variables for
these operations. Unsupported conditions fail closed, but a successful policy
creation alone does not prove authorization. Attachment-condition verification
requires the first CD-created data volume and remains an explicit apply gate.
Never remove
conditions or broaden to all instances/security lists to make deployment work.
If OCI cannot express that boundary, stop for a design decision.

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
