import type { Locale } from "@recount/i18n";
import type { ReactNode } from "react";
import {
	Body,
	Container,
	Head,
	Html,
	Img,
	Preview,
	Section,
} from "react-email";

const fontFamily = '"Helvetica Neue", Helvetica, Arial, system-ui, sans-serif';
export const emailStyles = {
	heading: {
		fontSize: "22px",
		fontWeight: 500,
		lineHeight: "28px",
		margin: "0 0 16px",
	},
	text: { fontSize: "14px", lineHeight: "22px", margin: "16px 0" },
	button: {
		backgroundColor: "#0f766e",
		color: "#ffffff",
		padding: "6px 12px",
		borderRadius: "4px",
		fontSize: "14px",
		lineHeight: "20px",
		fontWeight: 500,
	},
	link: {
		color: "#0f766e",
		fontSize: "13px",
		lineHeight: "20px",
		wordBreak: "break-all" as const,
	},
};

export function EmailLayout({
	locale,
	preview,
	children,
}: {
	locale: Locale;
	preview: string;
	children: ReactNode;
}) {
	return (
		<Html lang={locale}>
			<Head>
				<meta name="color-scheme" content="light dark" />
				<meta name="supported-color-schemes" content="light dark" />
				<style>{`
@media (prefers-color-scheme: dark) {
 .recount-email-body { background-color: #0c181c !important; color: #e3eef0 !important; }
 .recount-email-card { background-color: #132429 !important; border-color: #294047 !important; color: #e3eef0 !important; }
 .recount-email-button { background-color: #65d6c5 !important; color: #102724 !important; }
 .recount-email-link { color: #65d6c5 !important; }
 .recount-logo-light { display: none !important; }
 .recount-logo-dark { display: block !important; }
}`}</style>
			</Head>
			<Preview>{preview}</Preview>
			<Body
				className="recount-email-body"
				style={{
					backgroundColor: "#f5f7f8",
					color: "#0f1b1f",
					fontFamily,
					fontSize: "14px",
					margin: 0,
					padding: "24px 12px",
				}}
			>
				<Container
					className="recount-email-card"
					style={{
						backgroundColor: "#ffffff",
						color: "#0f1b1f",
						border: "1px solid #d9e2e5",
						borderRadius: "4px",
						padding: "20px",
						margin: "0 auto",
						maxWidth: "480px",
					}}
				>
					<Section style={{ marginBottom: "24px", padding: "4px" }}>
						<div role="img" aria-label="Recount">
							<Img
								className="recount-logo-light"
								src="cid:recount-logo-light"
								alt=""
								width={128}
								height={30}
								style={{ display: "block", width: "128px", height: "30px" }}
							/>
							<Img
								className="recount-logo-dark"
								src="cid:recount-logo-dark"
								alt=""
								width={128}
								height={30}
								style={{ display: "none", width: "128px", height: "30px" }}
							/>
						</div>
					</Section>
					{children}
				</Container>
			</Body>
		</Html>
	);
}
