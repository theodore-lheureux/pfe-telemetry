// The part of the Workers runtime module `cloudflare:email` used by the signup notification.
declare module "cloudflare:email" {
	export class EmailMessage {
		constructor(from: string, to: string, raw: string);
	}
}
