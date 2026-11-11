import type { CSSProperties, ReactNode } from "react";
import { Button, Column, Hr, Img, Link, Row, Section, Text } from "react-email";

// Tide Core light palette; email clients get fixed colors rather than theme tokens.
export const emailColors = {
	page: "#f5f7f8",
	card: "#ffffff",
	border: "#d9e2e5",
	foreground: "#0f1b1f",
	text: "#475a62",
	muted: "#6b7d84",
	panel: "#f1f5f6",
	primary: "#0f766e",
	accent: "#dcefec",
	accentForeground: "#0b4f4a",
};

export const fontFamily =
	'"Helvetica Neue", Helvetica, Arial, system-ui, sans-serif';
const monoFamily =
	'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

export const emailStyles = {
	heading: {
		fontSize: "22px",
		fontWeight: 600,
		lineHeight: "30px",
		letterSpacing: "-0.2px",
		margin: "0 0 12px",
		color: emailColors.foreground,
		overflowWrap: "anywhere",
	},
	text: {
		color: emailColors.text,
		fontSize: "15px",
		lineHeight: "24px",
		margin: "0 0 16px",
	},
	small: {
		color: emailColors.muted,
		fontSize: "13px",
		lineHeight: "20px",
		margin: "0 0 8px",
	},
	footer: {
		color: emailColors.muted,
		fontSize: "12px",
		lineHeight: "18px",
		margin: "0 0 6px",
	},
} satisfies Record<string, CSSProperties>;

export function EmailText({
	children,
	tone = "body",
	style,
}: {
	children: ReactNode;
	tone?: "body" | "small" | "footer";
	style?: CSSProperties;
}) {
	const base =
		tone === "small"
			? emailStyles.small
			: tone === "footer"
				? emailStyles.footer
				: emailStyles.text;
	return <Text style={{ ...base, ...style }}>{children}</Text>;
}

export function EmailDivider({ margin = "16px 0" }: { margin?: string }) {
	return (
		<Hr
			style={{ borderColor: emailColors.border, borderTopWidth: "1px", margin }}
		/>
	);
}

/** A quiet bordered panel for codes and quoted text. */
export function EmailPanel({
	children,
	style,
}: {
	children: ReactNode;
	style?: CSSProperties;
}) {
	return (
		<Section
			style={{
				backgroundColor: emailColors.panel,
				border: `1px solid ${emailColors.border}`,
				borderRadius: "6px",
				margin: "8px 0 20px",
				...style,
			}}
		>
			{children}
		</Section>
	);
}

export function EmailButton({
	href,
	children,
}: {
	href: string;
	children: ReactNode;
}) {
	return (
		<Section style={{ padding: "8px 0 24px" }}>
			<Button
				href={href}
				style={{
					backgroundColor: emailColors.primary,
					color: "#ffffff",
					padding: "11px 20px",
					borderRadius: "6px",
					fontSize: "15px",
					lineHeight: "22px",
					fontWeight: 600,
					textDecoration: "none",
				}}
			>
				{children}
			</Button>
		</Section>
	);
}

/** A one-time code, large and monospaced so it is easy to read and copy. */
export function EmailCode({ code }: { code: string }) {
	return (
		<EmailPanel style={{ padding: "20px 16px", textAlign: "center" }}>
			<Text
				style={{
					color: emailColors.foreground,
					fontFamily: monoFamily,
					fontSize: "32px",
					fontWeight: 600,
					lineHeight: "40px",
					letterSpacing: "8px",
					// Balances the trailing letter spacing after the last digit.
					paddingLeft: "8px",
					margin: 0,
				}}
			>
				{code}
			</Text>
		</EmailPanel>
	);
}

/**
 * A note from another person, modelled on shadcn's outlined Item with an avatar: who wrote
 * it on top, their words underneath, apart from Recount's own copy.
 */
export function EmailNote({
	author,
	avatarSrc,
	children,
}: {
	author: string;
	/** The author's photo; without one the note shows their initial. */
	avatarSrc?: string;
	children: ReactNode;
}) {
	const initial = author.trim().charAt(0).toUpperCase() || "?";
	return (
		<Section
			style={{
				border: `1px solid ${emailColors.border}`,
				borderRadius: "8px",
				margin: "8px 0 20px",
				padding: "14px 16px",
			}}
		>
			<Row>
				<Column style={{ width: "44px", verticalAlign: "top" }}>
					{avatarSrc ? (
						<Img
							src={avatarSrc}
							alt=""
							width={32}
							height={32}
							style={{
								borderRadius: "16px",
								display: "block",
								height: "32px",
								width: "32px",
							}}
						/>
					) : (
						<Text
							style={{
								backgroundColor: emailColors.accent,
								borderRadius: "16px",
								color: emailColors.accentForeground,
								fontSize: "13px",
								fontWeight: 600,
								height: "32px",
								lineHeight: "32px",
								margin: 0,
								textAlign: "center",
								width: "32px",
							}}
						>
							{initial}
						</Text>
					)}
				</Column>
				<Column style={{ verticalAlign: "top" }}>
					<Text
						style={{
							color: emailColors.foreground,
							fontSize: "14px",
							fontWeight: 600,
							lineHeight: "20px",
							margin: "0 0 2px",
							overflowWrap: "anywhere",
						}}
					>
						{author}
					</Text>
					<Text
						style={{
							...emailStyles.text,
							margin: 0,
							whiteSpace: "pre-wrap",
						}}
					>
						{children}
					</Text>
				</Column>
			</Row>
		</Section>
	);
}

/** The raw URL under a divider, for clients where the button does not work. */
export function EmailLinkFallback({
	label,
	href,
}: {
	label: string;
	href: string;
}) {
	return (
		<>
			<EmailDivider />
			<EmailText tone="small" style={{ margin: "0 0 4px" }}>
				{label}
			</EmailText>
			<Text style={{ margin: "0 0 8px" }}>
				<Link
					href={href}
					style={{
						color: emailColors.primary,
						fontSize: "13px",
						lineHeight: "20px",
						textDecoration: "underline",
						wordBreak: "break-all",
					}}
				>
					{href}
				</Link>
			</Text>
		</>
	);
}
