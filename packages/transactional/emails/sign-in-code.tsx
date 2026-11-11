import type { Locale } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import {
	EmailButton,
	EmailCode,
	EmailLinkFallback,
	EmailText,
} from "../src/email-components";
import { EmailLayout } from "../src/email-layout";

export interface SignInCodeEmailProps {
	locale: Locale;
	code: string;
	/** Opens sign-in with the code filled in; the person still confirms in the app. */
	url: string;
}

export default function SignInCodeEmail({
	code,
	locale,
	url,
}: SignInCodeEmailProps) {
	return (
		<EmailLayout
			locale={locale}
			preview={m.email_code_preview({}, { locale })}
			title={m.email_code_heading({}, { locale })}
			description={m.email_code_instructions({}, { locale })}
			footer={
				<EmailText tone="footer">
					{m.email_code_ignore({}, { locale })}
				</EmailText>
			}
		>
			<EmailCode code={code} />
			<EmailButton href={url}>
				{m.email_code_button({}, { locale })}
			</EmailButton>
			<EmailText tone="small">{m.email_code_warning({}, { locale })}</EmailText>
			<EmailLinkFallback
				label={m.email_link_fallback({}, { locale })}
				href={url}
			/>
		</EmailLayout>
	);
}

SignInCodeEmail.PreviewProps = {
	locale: "en",
	code: "012345",
	url: "https://telemetry.example.com/login#email=member%40example.com&code=012345",
} satisfies SignInCodeEmailProps;
