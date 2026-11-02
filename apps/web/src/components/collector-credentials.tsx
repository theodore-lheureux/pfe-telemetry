import { m } from "@pfe/i18n/messages";
import { CreateCredentialForm } from "./collector-credentials/create-credential-form";
import { CredentialActionDialog } from "./collector-credentials/credential-action-dialog";
import { CredentialList } from "./collector-credentials/credential-list";
import { TokenReveal } from "./collector-credentials/token-reveal";
import {
	type CollectorCredentialsOptions,
	useCollectorCredentials,
} from "./collector-credentials/use-collector-credentials";
import { CollectorSetup } from "./collector-setup";
import { Button } from "./ui/button";

export function CollectorCredentials({
	asOf,
	...options
}: CollectorCredentialsOptions & { asOf: number }) {
	const state = useCollectorCredentials(options);
	const selectedCredential = options.credentials?.find(
		({ id }) => id === state.confirmation?.id,
	);
	return (
		<div className="flex flex-col gap-6">
			<h2 ref={state.heading} tabIndex={-1} className="sr-only">
				{m.manage_collector_credentials()}
			</h2>
			{state.reveal && (
				<TokenReveal
					token={state.reveal.token}
					name={state.reveal.credential.name}
					onDismiss={() => void state.dismissToken()}
				/>
			)}
			<p role="status" className="text-sm">
				{state.pending ? m.updating_collector_credentials() : state.message}
			</p>
			{state.error && (
				<p role="alert" className="text-sm text-destructive">
					{state.error}
				</p>
			)}
			{(state.refreshError || options.credentials === null) && (
				<div
					role="alert"
					className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm"
				>
					<p>{m.could_not_confirm_the_current_credential_list_refresh()}</p>
					<Button
						variant="outline"
						disabled={!state.canRefresh}
						onClick={() => void state.refreshCredentials()}
					>
						{m.refresh_credential_list()}
					</Button>
				</div>
			)}
			<CredentialList
				credentials={options.credentials}
				asOf={asOf}
				pending={state.pending}
				disabled={state.disabled}
				onRequestAction={state.requestAction}
			/>
			{state.confirmation && selectedCredential && (
				<CredentialActionDialog
					confirmation={state.confirmation}
					credential={selectedCredential}
					pending={state.pending}
					disabled={state.disabled}
					error={state.error}
					fallbackFocus={state.heading}
					onConfirm={state.confirmAction}
					onCancel={state.cancelAction}
				/>
			)}
			<CreateCredentialForm disabled={state.disabled} create={state.create} />
			<CollectorSetup />
		</div>
	);
}
