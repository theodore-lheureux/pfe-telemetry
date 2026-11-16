# Shared infrastructure state

The existing S3 backend in `us-east-2` is shared by independent OpenTofu roots.
Use its existing account and bucket; another checkout does not need another
bucket. The bucket name retains its existing external identifier.

| Root                            | State key                          |
| ------------------------------- | ---------------------------------- |
| `infra/state-backend`           | `bootstrap/state-backend.tfstate`  |
| `infra/ingestion-bootstrap/aws` | `bootstrap/ingestion-aws.tfstate`  |
| `infra/ingestion-bootstrap/oci` | `bootstrap/ingestion-oci.tfstate`  |
| `infra/oci-ingestion`           | `oci/ingestion/terraform.tfstate`  |
| `infra/aws-collectors`          | `aws/collectors/terraform.tfstate` |

The ported configuration retains versioning, AES-256 encryption, public access
blocking, enforced bucket ownership, TLS-only access, denied bucket/version
deletion and `prevent_destroy`. Native S3 lock files need no DynamoDB table.
No backend infrastructure has been applied from this checkout.

## Use the existing backend

Copy `backend.hcl.example` to ignored `backend.hcl`, fill in the real bucket and
account, and select credentials separately:

```sh
export AWS_PROFILE=pfe
tofu -chdir=infra/state-backend init -backend-config=backend.hcl
tofu -chdir=infra/oci-ingestion init -backend-config=../state-backend/backend.hcl
```

Set `expected_account_id` in ignored `terraform.tfvars` for the state root.
An ordinary state-root plan must preserve the existing bucket and protections.
Do not apply an unexpected create or replacement. The root should already have
remote state; verify that before any recovery operation.

`imports.tf.example` preserves the earlier recovery imports without activating
them during normal plans or mocked tests. If state recovery is actually needed,
inspect the existing state, obtain approval, then enable and review those import
blocks. Imports write state and require approval. Never initialize a parallel
state, discard local state or use `-reconfigure` to bypass an existing lineage.
An approved state migration uses `init -migrate-state` with a private backup.

## Bootstrap and CD access

The state-backend root runs locally with AWS profile `pfe` to maintain the
existing bucket protections. The separate
[identity bootstrap](../ingestion-bootstrap/README.md) creates a dedicated IAM
user limited to the ingestion state and native lock object. Its access key is
stored only in the separate plan/apply environments; applies require approval.
There is no OIDC
provider and no IAM-management permission in CD.

The ingestion root's plan/apply runs in GitHub Actions, not on the owner's
machine. Its workflow serializes infrastructure runs and uses native S3 locking
for both plan and apply. Access-key rotation is documented in the bootstrap
guide. Bootstrap state remains outside CI's permitted prefix.

Use only the default workspace. Do not run a concurrent apply while reviewing
an unlocked local inspection plan. CD uses a scoped OCI API key and locks state.

## Recovery and access

State may contain secrets. Never upload plaintext plans/state to artifacts or log
downloaded snapshots. Operators performing an approved import/apply need
`GetObject`/`PutObject` on the exact state object, `GetObject`/`PutObject`/
`DeleteObject` on its `.tflock`, and narrowly scoped `ListBucket`.
Never grant `DeleteObject` on the state object or permanent version deletion.

Version recovery additionally needs `ListBucketVersions` and `GetObjectVersion`.
Stop other writers, retain a private backup and check lineage/serial before an
approved restore. Do not force-unlock an active writer. Version history has no
automatic expiry; review storage/request charges rather than deleting history.

See the [OpenTofu S3 backend reference](https://opentofu.org/docs/language/settings/backends/s3/)
and the [OCI deployment procedure](../oci-ingestion/README.md).
