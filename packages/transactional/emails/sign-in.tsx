import type { Locale } from "@pfe/i18n";
import { m } from "@pfe/i18n/messages";
import {
	Body,
	Button,
	Container,
	Head,
	Heading,
	Html,
	Link,
	Preview,
	Text,
} from "react-email";

export default function SignInEmail({
	url,
	locale,
}: {
	url: string;
	locale: Locale;
}) {
	return (
		<Html lang={locale}>
			<Head />
			<Preview>{m.email_sign_in_preview({}, { locale })}</Preview>
			<Body
				style={{ backgroundColor: "#f5f5f5", fontFamily: "Arial, sans-serif" }}
			>
				<Container
					style={{
						backgroundColor: "#fff",
						padding: "32px",
						margin: "32px auto",
						maxWidth: "480px",
					}}
				>
					<Heading>{m.email_sign_in_subject({}, { locale })}</Heading>
					<Text>{m.email_sign_in_body({}, { locale })}</Text>
					<Button
						href={url}
						style={{
							backgroundColor: "#171717",
							color: "#fff",
							padding: "12px 20px",
							borderRadius: "6px",
						}}
					>
						{m.sign_in({}, { locale })}
					</Button>
					<Text>{m.email_link_fallback({}, { locale })}</Text>
					<Link href={url}>{url}</Link>
					<Text>{m.email_sign_in_ignore({}, { locale })}</Text>
				</Container>
			</Body>
		</Html>
	);
}

SignInEmail.PreviewProps = {
	url: "https://telemetry.example.com/login",
	locale: "en",
};
