import type { Locale } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import type { ReactNode } from "react";
import {
	Body,
	Column,
	Container,
	Head,
	Heading,
	Html,
	Img,
	Link,
	Preview,
	Row,
	Section,
} from "react-email";
import { emailBrandAssets } from "./brand-assets";
import {
	EmailDivider,
	EmailText,
	emailColors,
	emailStyles,
	fontFamily,
} from "./email-components";

// Sent mail references brand images as inline attachments. The preview server cannot
// resolve `cid:` URLs, so it renders the same images from data URLs.
const runtime = globalThis as {
	process?: { env: Record<string, string | undefined> };
};
const preview = Boolean(runtime.process?.env.RECOUNT_EMAIL_PREVIEW);
const brandSrc = (cid: string, base64: string) =>
	preview ? `data:image/png;base64,${base64}` : `cid:${cid}`;
const logoSrc = brandSrc("recount-logo-light", emailBrandAssets.light);
const symbolSrc = brandSrc("recount-symbol", emailBrandAssets.symbol);

const SITE_URL = "https://recount.cloud";
const GITHUB_URL = "https://github.com/theodore-lheureux/pfe-telemetry";

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
	/** Why the recipient got this email; shown under the card. */
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
					backgroundColor: emailColors.page,
					color: emailColors.text,
					fontFamily,
					fontSize: "15px",
					lineHeight: "24px",
					margin: 0,
					padding: 0,
				}}
			>
				<Section style={{ padding: "40px 12px" }}>
					<Container style={{ margin: "0 auto", maxWidth: "520px" }}>
						<Section
							style={{
								backgroundColor: emailColors.card,
								border: `1px solid ${emailColors.border}`,
								borderRadius: "8px",
							}}
						>
							<Section style={{ padding: "24px 32px 0" }}>
								<Img
									src={logoSrc}
									alt="Recount"
									width={102}
									height={24}
									style={{ display: "block", width: "102px", height: "24px" }}
								/>
							</Section>
							<Section style={{ padding: "28px 32px 16px" }}>
								<Heading as="h1" style={emailStyles.heading}>
									{title}
								</Heading>
								{description ? <EmailText>{description}</EmailText> : null}
								{children}
							</Section>
						</Section>
						<Section style={{ padding: "16px 32px 0" }}>{footer}</Section>
						<SiteFooter locale={locale} />
					</Container>
				</Section>
			</Body>
		</Html>
	);
}

// Echoes the landing site footer: symbol and tagline above a hairline, then the copyright
// on the left and site links on the right.
function SiteFooter({ locale }: { locale: Locale }) {
	const site = (path: string) =>
		`${SITE_URL}${locale === "fr" ? "/fr" : ""}${path}`;
	const links = [
		{ href: site("/docs/"), label: m.email_footer_docs({}, { locale }) },
		{ href: site("/privacy/"), label: m.email_footer_privacy({}, { locale }) },
		{ href: site("/terms/"), label: m.email_footer_terms({}, { locale }) },
		{ href: GITHUB_URL, label: "GitHub" },
	];
	return (
		<Section style={{ padding: "28px 32px 0" }}>
			<Img
				src={symbolSrc}
				alt=""
				width={24}
				height={24}
				style={{ display: "block", width: "24px", height: "24px" }}
			/>
			<EmailText tone="footer" style={{ fontSize: "13px", margin: "10px 0 0" }}>
				{m.email_footer_tagline({}, { locale })}
			</EmailText>
			<EmailDivider margin="20px 0 14px" />
			<Row>
				<Column style={{ verticalAlign: "top" }}>
					<EmailText tone="footer" style={{ margin: 0 }}>
						© {new Date().getUTCFullYear()} Recount
					</EmailText>
				</Column>
				<Column align="right" style={{ verticalAlign: "top" }}>
					<EmailText tone="footer" style={{ margin: 0 }}>
						{links.map((link, index) => (
							<span key={link.href}>
								{index > 0 ? (
									<span style={{ color: emailColors.border }}> · </span>
								) : null}
								<Link
									href={link.href}
									style={{ color: emailColors.muted, textDecoration: "none" }}
								>
									{link.label}
								</Link>
							</span>
						))}
					</EmailText>
				</Column>
			</Row>
		</Section>
	);
}
