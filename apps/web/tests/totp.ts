import { createHmac } from "node:crypto";

export function authenticatorCode(uri: string) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = "";
	for (const letter of new URL(uri).searchParams.get("secret") ?? "")
		bits += alphabet.indexOf(letter.toUpperCase()).toString(2).padStart(5, "0");
	const key = Buffer.from(
		Array.from({ length: Math.floor(bits.length / 8) }, (_, index) =>
			Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2),
		),
	);
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
	const hash = createHmac("sha1", key).update(counter).digest();
	return String(
		(hash.readUInt32BE(hash[hash.length - 1] & 15) & 0x7fffffff) % 1_000_000,
	).padStart(6, "0");
}
