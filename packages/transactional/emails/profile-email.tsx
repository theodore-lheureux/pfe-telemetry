import type { Locale } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import { EmailButton, EmailText } from "../src/email-components";
import { EmailLayout } from "../src/email-layout";

export type ProfileEmailProps = { locale: Locale; email: string } & (
	| { kind: "verification"; url: string }
	| { kind: "changed"; newEmail: string; url: string }
);

export default function ProfileEmail(props: ProfileEmailProps) {
	const options = { locale: props.locale };
	const title =
		props.kind === "verification"
			? m.profile_email_change_verify_subject({}, options)
			: m.profile_email_change_notice_subject({}, options);
	return (
		<EmailLayout
			locale={props.locale}
			preview={title}
			title={title}
			footer={
				props.kind === "verification"
					? m.profile_email_change_ignore({}, options)
					: m.profile_email_change_notice_footer({}, options)
			}
		>
			{props.kind === "verification" ? (
				<>
					<EmailText>
						{m.profile_email_change_verify_body(
							{ email: props.email },
							options,
						)}
					</EmailText>
					<EmailButton href={props.url}>
						{m.profile_email_change_confirm({}, options)}
					</EmailButton>
					<EmailText>{m.profile_email_change_link_help({}, options)}</EmailText>
				</>
			) : (
				<>
					<EmailText>
						{m.profile_email_change_notice_body(
							{ previousEmail: props.email, newEmail: props.newEmail },
							options,
						)}
					</EmailText>
					<EmailText>{m.profile_email_change_recovery({}, options)}</EmailText>
					<EmailButton href={props.url}>
						{m.profile_email_change_review_security({}, options)}
					</EmailButton>
				</>
			)}
		</EmailLayout>
	);
}
