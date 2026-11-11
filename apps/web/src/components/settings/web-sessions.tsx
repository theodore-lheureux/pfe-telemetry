import { m } from "@recount/i18n/messages";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useHydrated } from "@tanstack/react-router";
import { LogOutIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import {
	listWebSessions,
	revokeWebSession,
} from "../../auth/profile.functions";
import { unwrapOperation } from "../../lib/operation-result";
import { FormFeedback } from "../form-feedback";
import { useStepUpAuthentication } from "../step-up-authentication";
import { TimeDisplay } from "../time-display";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";
import { useAppMutation } from "../use-app-mutation";

export function WebSessions() {
	const { user, authentication } = getRouteApi("/_app").useRouteContext();
	const requireStepUp = useStepUpAuthentication();
	const identity = useSyncExternalStore(
		authentication.subscribe,
		authentication.getSnapshot,
		authentication.getSnapshot,
	);
	const hydrated = useHydrated();
	const client = useQueryClient();
	const queryKey = ["account-web-sessions", user.id, identity.revision];
	const sessions = useQuery({
		queryKey,
		enabled: hydrated && !identity.pending,
		retry: false,
		staleTime: 0,
		gcTime: 0,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		queryFn: async ({ signal }) => {
			const data = unwrapOperation(await listWebSessions({ signal }));
			const current = authentication.getSnapshot();
			if (
				current.pending ||
				current.revision !== identity.revision ||
				data.some((session) => session.userId !== user.id)
			)
				throw new Error("Identity changed");
			return data;
		},
	});
	const mutation = useAppMutation({
		userId: user.id,
		save: (data: { id: string }, signal) => revokeWebSession({ data, signal }),
	});
	async function revoke(id: string) {
		if (!(await requireStepUp({ userId: user.id, email: user.email }))) return;
		const result = await mutation.submit({ id });
		if (result && !result.error)
			await result.refresh(async () => {
				await client.invalidateQueries({ queryKey });
			});
	}
	return (
		<>
			{sessions.isPending ? (
				<p role="status">{m.loading()}</p>
			) : sessions.isError ? (
				<div className="flex flex-col items-start gap-2">
					<p role="alert">{m.web_sessions_unavailable()}</p>
					<Button variant="outline" onClick={() => void sessions.refetch()}>
						{m.try_again()}
					</Button>
				</div>
			) : (
				<Card className="gap-0 border py-0 ring-0">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{m.device()}</TableHead>
								<TableHead>{m.session_location()}</TableHead>
								<TableHead>{m.signed_in_with()}</TableHead>
								<TableHead>{m.started_at()}</TableHead>
								<TableHead>{m.last_active()}</TableHead>
								<TableHead>
									<span className="sr-only">{m.actions()}</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{sessions.data.map((session) => (
								<TableRow key={session.id} className="h-12">
									<TableCell className="whitespace-nowrap">
										<div className="flex items-center gap-2">
											<span>{session.device || m.unknown_device()}</span>
											{session.current && (
												<Badge variant="outline">{m.this_device()}</Badge>
											)}
										</div>
									</TableCell>
									<TableCell
										title={
											session.location.kind === "unknown"
												? m.location_unavailable()
												: session.location.address
										}
									>
										{session.location.kind === "local"
											? m.local_network()
											: session.location.kind === "ip"
												? session.location.address
												: m.unknown_session_value()}
									</TableCell>
									<TableCell>
										{session.signInMethod === "passkey"
											? m.passkey()
											: session.signInMethod === "email-otp"
												? m.email_code_method()
												: m.unknown_session_value()}
									</TableCell>
									<TableCell className="whitespace-nowrap">
										<TimeDisplay value={session.createdAt} mode="compact" />
									</TableCell>
									<TableCell
										className="whitespace-nowrap"
										title={m.session_activity_help()}
									>
										<TimeDisplay
											value={session.current ? new Date() : session.updatedAt}
											mode="relative"
										/>
									</TableCell>
									<TableCell className="w-12">
										{!session.current ? (
											<Button
												variant="ghost"
												size="icon"
												className="text-destructive"
												aria-label={m.revoke_device()}
												title={m.revoke_device()}
												disabled={
													mutation.disabled ||
													mutation.pending ||
													mutation.status === "uncertain" ||
													mutation.status === "refresh-failed"
												}
												onClick={() => void revoke(session.id)}
											>
												<LogOutIcon aria-hidden="true" />
											</Button>
										) : (
											<span aria-hidden="true" className="block size-8" />
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Card>
			)}
			<FormFeedback
				message={mutation.message}
				kind={mutation.kind}
				pending={mutation.pending}
				reserveLine={false}
			/>
		</>
	);
}
