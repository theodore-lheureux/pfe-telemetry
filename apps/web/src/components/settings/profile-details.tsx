import { m } from "@recount/i18n/messages";
import { getRouteApi } from "@tanstack/react-router";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { refreshBetterAuthIdentity } from "../../auth/identity-state";
import { updateProfileName } from "../../auth/profile.functions";
import { RenameEntityForm } from "../entity-form";
import { UserAvatar } from "../identity-avatar";
import { Button } from "../ui/button";
import { ProfileEmail } from "./profile-email";
import { SettingsSection } from "./settings-section";

export function ProfileDetails() {
	const { user } = getRouteApi("/_app").useRouteContext();
	const [refresh, setRefresh] = useState(0);
	return (
		<>
			<SettingsSection id="profile-picture" title={m.profile_picture()}>
				<div className="flex flex-col items-start gap-4 sm:flex-row">
					<UserAvatar
						user={user}
						className="size-16 shrink-0 text-lg [&_[data-slot=avatar-fallback]]:text-lg"
						imageSize={256}
						refresh={refresh}
					/>
					<div className="flex min-w-0 flex-col gap-3">
						<p className="text-sm text-muted-foreground">
							{m.profile_picture_help({ email: user.email })}
						</p>
						<div className="flex flex-wrap gap-2">
							<Button variant="outline" asChild>
								<a
									href="https://gravatar.com/profile/avatars"
									target="_blank"
									rel="noopener noreferrer"
								>
									{m.change_on_gravatar()}
									<ExternalLinkIcon aria-hidden="true" />
								</a>
							</Button>
							<Button variant="outline" onClick={() => setRefresh(Date.now())}>
								<RefreshCwIcon aria-hidden="true" />
								{m.check_again()}
							</Button>
						</div>
					</div>
				</div>
			</SettingsSection>
			<SettingsSection id="details" title={m.profile_details()}>
				<RenameEntityForm
					requireChanged
					reserveFeedbackLine={false}
					name={user.name}
					className="max-w-2xl border-0 bg-transparent p-0"
					submitLabel={m.save_name()}
					save={({ name }, signal) =>
						updateProfileName({ data: { name, userId: user.id }, signal })
					}
					onSuccess={async () => {
						await refreshBetterAuthIdentity();
					}}
				/>
				<ProfileEmail />
			</SettingsSection>
		</>
	);
}
