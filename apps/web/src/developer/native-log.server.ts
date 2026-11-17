const sensitiveLine =
	/\b(?:authorization|proxy-authorization|set-cookie|cookie|[\w-]*(?:password|passwd|token|secret|credential|private[_-]key|enrollment[_-]key|api[_-]key|access[_-]key)[\w-]*)["']?\s*[:=]|\brecount_enroll_[\w-]+|[?&](?:X-Amz-Signature|X-Goog-Signature)=|[a-z][\w+.-]*:\/\/[^/\s@]+:[^/\s@]+@/i;

// Keep colour (SGR) sequences for the viewer; drop every other terminal control.
const controls =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control sequences.
	/(\x1b\[[0-9;]*m)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|[\x00-\x08\x0b-\x1f\x7f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: colour sequences.
const colours = /\x1b\[[0-9;]*m/g;

export function redactNativeLog(output: string[], token: string) {
	let privateKey = false;
	return output
		.join("\n")
		.split("\n")
		.map((line) => {
			const coloured = line.replace(controls, (_, colour) => colour ?? "");
			const text = coloured.replace(colours, "");
			if (/-----BEGIN .*PRIVATE KEY-----/.test(text)) privateKey = true;
			const redact = privateKey || sensitiveLine.test(text);
			if (/-----END .*PRIVATE KEY-----/.test(text)) privateKey = false;
			if (redact) return "[redacted]";
			if (/\bRECOUNT_PUBLIC(?:_|\s)/.test(text)) return "";
			if (!token || !text.includes(token)) return coloured;
			// A token split by colour codes cannot be masked in place.
			return coloured.includes(token)
				? coloured.replaceAll(token, "[redacted]")
				: "[redacted]";
		})
		.filter((line) => line.replace(colours, "") !== "")
		.join("\n");
}
