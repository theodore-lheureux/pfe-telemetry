import { formatDate, formatSeconds } from "@pfe/i18n";
import { statusLabel } from "@pfe/i18n/labels";
import { m } from "@pfe/i18n/messages";
import type { ReactNode } from "react";
import type { CollectorCredentialSummary } from "../../credentials/contracts";
import { credentialStatus } from "../../credentials/setup";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import type { CredentialAction } from "./use-collector-credentials";

export function CredentialList({
	credentials,
	asOf,
	pending,
	disabled,
	onRequestAction,
}: {
	credentials: CollectorCredentialSummary[] | null;
	asOf: number;
	pending: boolean;
	disabled: boolean;
	onRequestAction: (
		id: string,
		action: CredentialAction,
		trigger: HTMLButtonElement,
	) => void;
}) {
	return (
		<section
			className="flex flex-col gap-4 rounded-lg border p-5"
			aria-labelledby="credential-list-title"
			aria-busy={pending}
		>
			<h2 id="credential-list-title" className="font-semibold">
				{m.enrolled_sources()}
			</h2>
			<p className="text-sm text-muted-foreground">
				{m.tokens_are_shown_only_immediately_after_creation_or()}
			</p>
			{credentials === null ? (
				<p className="text-sm">{m.credential_list_unavailable()}</p>
			) : credentials.length ? (
				<ul className="divide-y">
					{credentials.map((credential) => {
						const status = credentialStatus(credential, asOf);
						return (
							<li key={credential.id} className="flex flex-col gap-3 py-4">
								<div className="flex flex-wrap items-center justify-between gap-3">
									<h3 className="font-medium">
										{credential.name}{" "}
										<Badge variant="secondary">· {statusLabel(status)}</Badge>
									</h3>
									<div className="flex gap-2">
										<Button
											type="button"
											variant="outline"
											disabled={disabled || status !== "Active"}
											aria-label={m.rotate_named({ name: credential.name })}
											onClick={(event) =>
												onRequestAction(
													credential.id,
													"rotate",
													event.currentTarget,
												)
											}
										>
											{m.rotate()}
										</Button>
										<Button
											type="button"
											variant="outline"
											disabled={disabled || status === "Revoked"}
											aria-label={m.revoke_named({ name: credential.name })}
											onClick={(event) =>
												onRequestAction(
													credential.id,
													"revoke",
													event.currentTarget,
												)
											}
										>
											{m.revoke()}
										</Button>
									</div>
								</div>
								<dl className="grid gap-2 text-sm sm:grid-cols-2">
									<Detail label={m.source_id()}>{credential.sourceId}</Detail>
									<Detail label={m.credential_id()}>{credential.id}</Detail>
									<Detail label={m.allowed_host_ids()}>
										{credential.hosts.length
											? credential.hosts.join(", ")
											: m.none_only_submissions_without_a_host_id()}
									</Detail>
									<Detail label={m.host_identification()}>
										{credential.requireHostId
											? m.required()
											: m.optional_provided_ids_must_be_allowed()}
									</Detail>
									<Detail label={m.maximum_submission_age()}>
										{formatSeconds(credential.maximumSubmissionAge)}
									</Detail>
									<Detail label={m.allowed_clock_skew()}>
										{formatSeconds(credential.allowedClockSkew)}
									</Detail>
									<Detail label={m.created()}>
										{date(credential.createdAt)}
									</Detail>
									<Detail label={m.expires()}>
										{credential.expiresAt
											? date(credential.expiresAt)
											: m.never()}
									</Detail>
									{credential.rotatedAt && (
										<Detail label={m.last_rotated()}>
											{date(credential.rotatedAt)}
										</Detail>
									)}
									{credential.revokedAt && (
										<Detail label={m.status_revoked()}>
											{date(credential.revokedAt)}
										</Detail>
									)}
								</dl>
							</li>
						);
					})}
				</ul>
			) : (
				<p className="text-sm">
					{m.no_collector_credentials_yet_create_one_to_enroll()}
				</p>
			)}
		</section>
	);
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="min-w-0">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="break-words">{children}</dd>
		</div>
	);
}

function date(value: Date) {
	return <time dateTime={value.toISOString()}>{formatDate(value)} UTC</time>;
}
