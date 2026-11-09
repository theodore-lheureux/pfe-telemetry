import type { Locale } from "@recount/i18n";
import type { ReactNode } from "react";
import {
	Body,
	Container,
	Head,
	Heading,
	Html,
	Img,
	Preview,
	Section,
	Text,
} from "react-email";

const fontFamily = '"Helvetica Neue", Helvetica, Arial, system-ui, sans-serif';
export const emailStyles = {
	heading: {
		fontSize: "22px",
		fontWeight: 600,
		lineHeight: "28px",
		margin: "0 0 16px",
		color: "#18181b",
		overflowWrap: "anywhere" as const,
	},
	text: { fontSize: "16px", lineHeight: "24px", margin: "16px 0" },
	footer: {
		color: "#71717a",
		fontSize: "14px",
		lineHeight: "22px",
		margin: "16px 0 0",
	},
	button: {
		backgroundColor: "#18181b",
		color: "#ffffff",
		padding: "12px 20px",
		borderRadius: "4px",
		fontSize: "16px",
		lineHeight: "24px",
		fontWeight: 600,
	},
	link: {
		color: "#52525b",
		fontSize: "14px",
		lineHeight: "22px",
		textDecoration: "underline",
		wordBreak: "break-all" as const,
	},
};

export function EmailLayout({
	locale,
	preview,
	title,
	description,
	children,
	footer,
}: {
	locale: Locale;
	preview: string;
	title: string;
	description?: string;
	children: ReactNode;
	footer: ReactNode;
}) {
	return (
		<Html lang={locale}>
			<Head>
				<meta name="color-scheme" content="light" />
				<meta name="supported-color-schemes" content="light" />
			</Head>
			<Preview>{preview}</Preview>
			<Body
				style={{
					backgroundColor: "#ffffff",
					color: "#52525b",
					fontFamily,
					fontSize: "16px",
					lineHeight: "24px",
					margin: 0,
					padding: 0,
				}}
			>
				<Section style={{ padding: "40px 12px 32px" }}>
					<Container style={{ margin: "0 auto", maxWidth: "576px" }}>
						<Heading as="h1" style={emailStyles.heading}>
							{title}
						</Heading>
						{description ? (
							<Text style={emailStyles.text}>{description}</Text>
						) : null}
						{children}
						<Section style={{ paddingTop: "48px" }}>
							<Img
								src="cid:recount-logo-light"
								alt="Recount"
								width={96}
								height={23}
								style={{ display: "block", width: "96px", height: "23px" }}
							/>
							{footer}
						</Section>
					</Container>
				</Section>
			</Body>
		</Html>
	);
}
