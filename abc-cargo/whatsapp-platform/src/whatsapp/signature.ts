/**
 * Verification of Meta webhook signatures.
 *
 * Meta signs every webhook POST body with HMAC-SHA256 using the App Secret
 * and sends the result in the `X-Hub-Signature-256` header as
 * `sha256=<hex>`. The raw request body must be used, byte for byte.
 */

const encoder = new TextEncoder();

export async function computeHmacSha256Hex(
	secret: string,
	payload: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(payload),
	);
	return bytesToHex(new Uint8Array(signature));
}

export async function verifyMetaSignature(
	rawBody: string,
	signatureHeader: string | null | undefined,
	appSecret: string,
): Promise<boolean> {
	if (!signatureHeader || !appSecret) return false;
	const [scheme, received] = signatureHeader.split("=");
	if (scheme !== "sha256" || !received) return false;
	const expected = await computeHmacSha256Hex(appSecret, rawBody);
	return timingSafeEqual(expected, received.toLowerCase());
}

/** Constant-time string comparison to avoid leaking match length. */
export function timingSafeEqual(a: string, b: string): boolean {
	const bytesA = encoder.encode(a);
	const bytesB = encoder.encode(b);
	if (bytesA.length !== bytesB.length) return false;
	let diff = 0;
	for (let i = 0; i < bytesA.length; i++) {
		diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
	}
	return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}
