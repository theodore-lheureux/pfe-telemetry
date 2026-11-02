import { InputError } from "../lib/input-error";

export const collectorBuildCommand = `cargo build --locked --release -p pfe-collector
install -d -m 0755 "$HOME/.local/bin"
install -m 0755 target/release/pfe-collector "$HOME/.local/bin/pfe-collector"`;

export const collectorTokenCommand = `umask 077
set +x
unset PFE_TOKEN
if install -d -m 700 "$HOME/.config/pfe-telemetry"; then
  if IFS= read -r -s -p 'Paste collector token: ' PFE_TOKEN &&
     install -m 600 /dev/null "$HOME/.config/pfe-telemetry/collector.token"; then
    printf '%s\\n' "$PFE_TOKEN" > "$HOME/.config/pfe-telemetry/collector.token"
  fi
fi
printf '\\n'
unset PFE_TOKEN`;

export const collectorRunCommand = `"$HOME/.local/bin/pfe-collector" \\
  --endpoint http://127.0.0.1:14317 \\
  --source-token-file "$HOME/.config/pfe-telemetry/collector.token" \\
  --host-id 'REPLACE_WITH_ENROLLED_HOST_ID' \\
  --visibility restricted \\
  --process-namespace-id 'REPLACE_WITH_NAMESPACE_ID' \\
  --queue-directory "$HOME/.local/state/pfe-telemetry/queue"`;

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
	hosts: string;
	requireHostId: boolean;
	expiresAt: string;
	maximumSubmissionAge: string;
	allowedClockSkew: string;
}

export function credentialFormValues(form: CredentialFormValues) {
	const name = form.name.trim();
	if (!name || name.length > 120)
		throw new InputError("INVALID_NAME", "Name must contain 1–120 characters.");
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
	const hosts = form.hosts
		.split(/\r?\n/)
		.map((host) => host.trim())
		.filter(Boolean);
	const requireHostId = form.requireHostId;
	if (requireHostId && !hosts.length)
		throw new InputError(
			"HOSTS_REQUIRED",
			"Enter at least one allowed host ID when host identification is required.",
		);
	if (hosts.length > 256 || new Set(hosts).size !== hosts.length)
		throw new InputError(
			"HOSTS_UNIQUE",
			"Enter up to 256 unique host IDs, one per line.",
		);
	const sourceId = form.sourceId.trim();
	if (
		[sourceId, ...hosts].some(
			(id) =>
				!id || new TextEncoder().encode(id).length > 128 || /\p{Cc}/u.test(id),
		)
	)
		throw new InputError(
			"INVALID_IDENTIFIER",
			"Source and host IDs must contain 1–128 UTF-8 bytes without control characters.",
		);
	return {
		name,
		sourceId,
		hosts,
		requireHostId,
		maximumSubmissionAge: Number(form.maximumSubmissionAge),
		allowedClockSkew: Number(form.allowedClockSkew),
		expiresAt: expiresAt?.toISOString() ?? null,
	};
}
