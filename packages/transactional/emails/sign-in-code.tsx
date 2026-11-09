import type { Locale } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import { Heading, Text } from "react-email";
import { EmailLayout, emailStyles } from "../src/email-layout";

export default function SignInCodeEmail({
	code,
	locale,
}: {
	code: string;
	locale: Locale;
}) {
	return (
		<EmailLayout locale={locale} preview={m.email_code_preview({}, { locale })}>
			<Heading style={emailStyles.heading}>
				{m.email_code_heading({}, { locale })}
			</Heading>
			<Text style={emailStyles.text}>
				{m.email_code_instructions({}, { locale })}
			</Text>
			<Text
				style={{
					...emailStyles.text,
					fontSize: "28px",
					fontWeight: 500,
					letterSpacing: "6px",
					fontVariantNumeric: "tabular-nums",
				}}
			>
				{code}
			</Text>
			<Text style={emailStyles.text}>
				{m.email_code_warning({}, { locale })}
			</Text>
			<Text style={emailStyles.text}>
				{m.email_code_ignore({}, { locale })}
			</Text>
		</EmailLayout>
	);
}

SignInCodeEmail.PreviewProps = { code: "012345", locale: "en" };
