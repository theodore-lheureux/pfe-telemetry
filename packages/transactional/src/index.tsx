import { render, toPlainText } from "react-email";
import SignInEmail from "../emails/sign-in";

export async function renderSignInEmail(url: string) {
	const html = await render(<SignInEmail url={url} />);
	return {
		subject: "Sign in to PFE Telemetry",
		html,
		text: toPlainText(html),
	};
}
