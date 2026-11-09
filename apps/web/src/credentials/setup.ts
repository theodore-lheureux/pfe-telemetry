import { InputError } from "../lib/input-error";
import { parseCollectorCredentialValues } from "./validation";

export const collectorBuildCommand = `cargo build --locked --release -p recount-collector
install -d -m 0755 "$HOME/.local/bin"
install -m 0755 target/release/recount-collector "$HOME/.local/bin/recount-collector"`;

export const collectorTokenCommand = `umask 077
set +x
unset RECOUNT_TOKEN
if install -d -m 700 "$HOME/.config/recount"; then
  if IFS= read -r -s -p 'Paste collector token: ' RECOUNT_TOKEN &&
     install -m 600 /dev/null "$HOME/.config/recount/collector.token"; then
    printf '%s\\n' "$RECOUNT_TOKEN" > "$HOME/.config/recount/collector.token"
  fi
fi
printf '\\n'
unset RECOUNT_TOKEN`;

export const collectorRunCommand = `"$HOME/.local/bin/recount-collector" \\
  --endpoint http://127.0.0.1:14317 \\
  --source-token-file "$HOME/.config/recount/collector.token" \\
  --host-id 'REPLACE_WITH_ENROLLED_HOST_ID' \\
  --visibility restricted \\
  --process-namespace-id 'REPLACE_WITH_NAMESPACE_ID' \\
  --queue-directory "$HOME/.local/state/recount/queue"`;

export function credentialStatus(
	credential: { revokedAt: Date | null; expiresAt: Date | null },
	now = Date.now(),
): "Active" | "Expired" | "Revoked" {
	if (credential.revokedAt) return "Revoked";
	if (credential.expiresAt && credential.expiresAt.getTime() <= now)
		return "Expired";
	return "Active";
}

export interface CredentialFormValues {
	name: string;
	sourceId: string;
	rootId: string;
	expiresAt: string;
	maximumSubmissionAge: string;
	allowedClockSkew: string;
}

export function credentialFormValues(form: CredentialFormValues) {
	const expiry = form.expiresAt;
	const expiresAt = expiry ? new Date(expiry) : null;
	if (
		expiresAt &&
		(!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())
	)
		throw new InputError(
			"INVALID_EXPIRY",
			"Choose an expiration in the future, or leave it empty.",
		);
	return parseCollectorCredentialValues({
		name: form.name,
		sourceId: form.sourceId.trim(),
		rootId: form.rootId.trim(),
		rootKind: 1,
		adapter: "linux" as const,
		allowedLocalKinds: [4],
		maximumSubmissionAge: Number(form.maximumSubmissionAge),
		allowedClockSkew: Number(form.allowedClockSkew),
		expiresAt: expiresAt?.toISOString() ?? null,
	});
}
