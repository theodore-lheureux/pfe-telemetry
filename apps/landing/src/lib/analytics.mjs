// Cloudflare Web Analytics for recount.cloud. The site token is public; it ships in every page.
// The beacon loads only on the production host, so previews and local builds are not counted.
const token = "182a867f5c084a05906299593434c12e";

export const analyticsScript = `if (location.hostname === "recount.cloud") {
	const beacon = document.createElement("script");
	beacon.defer = true;
	beacon.src = "https://static.cloudflareinsights.com/beacon.min.js";
	beacon.dataset.cfBeacon = ${JSON.stringify(JSON.stringify({ token }))};
	document.head.append(beacon);
}`;
