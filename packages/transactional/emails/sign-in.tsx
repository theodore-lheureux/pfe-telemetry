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

export default function SignInEmail({ url }: { url: string }) {
	return (
		<Html lang="en">
			<Head />
			<Preview>Your sign-in link for PFE Telemetry</Preview>
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
					<Heading>Sign in to PFE Telemetry</Heading>
					<Text>
						Use this link to sign in or recover access to your account. It
						expires in five minutes and can only be used once.
					</Text>
					<Button
						href={url}
						style={{
							backgroundColor: "#171717",
							color: "#fff",
							padding: "12px 20px",
							borderRadius: "6px",
						}}
					>
						Sign in
					</Button>
					<Text>If the button does not work, open this link:</Text>
					<Link href={url}>{url}</Link>
					<Text>
						If you did not request this email, you can ignore it. Do not forward
						this link.
					</Text>
				</Container>
			</Body>
		</Html>
	);
}

SignInEmail.PreviewProps = { url: "https://telemetry.example.com/login" };
