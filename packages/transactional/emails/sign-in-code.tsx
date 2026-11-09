import type { Locale } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import { Text } from "react-email";
import { EmailLayout, emailStyles } from "../src/email-layout";

export default function SignInCodeEmail({
	code,
	locale,
}: {
	code: string;
	locale: Locale;
}) {
	return (
		<EmailLayout
			locale={locale}
			preview={m.email_code_preview({}, { locale })}
			title={m.email_code_heading({}, { locale })}
			description={m.email_code_instructions({}, { locale })}
			footer={
				<>
					<Text style={emailStyles.footer}>
						{m.email_code_warning({}, { locale })}
					</Text>
					<Text style={emailStyles.footer}>
						{m.email_code_ignore({}, { locale })}
					</Text>
				</>
			}
		>
			<Text
				style={{
					...emailStyles.text,
					fontSize: "28px",
					fontWeight: 600,
					color: "#18181b",
					margin: "24px 0 0",
					lineHeight: "36px",
					letterSpacing: "6px",
					fontVariantNumeric: "tabular-nums",
				}}
			>
				{code}
			</Text>
		</EmailLayout>
	);
}

SignInCodeEmail.PreviewProps = { code: "012345", locale: "en" };
