/**
 * Cloudflare Access assertions, verified.
 *
 * Access puts the signed-in person's identity in two headers. One of them,
 * `Cf-Access-Authenticated-User-Email`, is tempting and wrong to use on its
 * own: this Worker answers on a public hostname, so anything that merely reads
 * a header trusts whoever sent it. Anyone who knows the address could add that
 * header themselves and become whoever they liked.
 *
 * The header that can be trusted is `Cf-Access-Jwt-Assertion`, and only after
 * its signature has been checked against the account's own public keys. That
 * is what this module does, and it is the whole reason it exists.
 */

export interface AccessIdentity {
	email: string;
	/** Access's own subject identifier for the person. */
	subject: string;
	/** The identity provider's user id, when Access passes one through. */
	identityNonce?: string;
	expiresAt: Date;
}

export class AccessRejected extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "AccessRejected";
		this.code = code;
	}
}

interface Jwk {
	kid: string;
	kty: string;
	alg?: string;
	n: string;
	e: string;
	use?: string;
}

export interface AccessConfig {
	/** e.g. "abccargo" in https://abccargo.cloudflareaccess.com */
	teamDomain: string;
	/** The Application Audience tag from the Access application. */
	audience: string;
}

/* ------------------------------------------------------------------ base64 */

function base64UrlToBytes(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function base64UrlToJson(value: string): unknown {
	return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

/* -------------------------------------------------------------------- JWKS */

interface CachedKeys {
	keys: Map<string, CryptoKey>;
	fetchedAt: number;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
const jwksCache = new Map<string, CachedKeys>();

/** Discards the cached signing keys. For tests, and for a forced refresh. */
export function clearKeyCache(): void {
	jwksCache.clear();
}

async function importKey(jwk: Jwk): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"jwk",
		{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
}

async function signingKeys(
	config: AccessConfig,
	fetcher: typeof fetch,
): Promise<Map<string, CryptoKey>> {
	const url = `https://${config.teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
	const cached = jwksCache.get(url);
	if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;

	const response = await fetcher(url);
	if (!response.ok) {
		throw new AccessRejected(
			"jwks_unavailable",
			`could not fetch Access signing keys (${response.status})`,
		);
	}
	const body = (await response.json()) as { keys?: Jwk[] };
	if (!Array.isArray(body.keys) || body.keys.length === 0) {
		throw new AccessRejected("jwks_empty", "Access returned no signing keys");
	}

	const keys = new Map<string, CryptoKey>();
	for (const jwk of body.keys) {
		if (jwk.kty !== "RSA" || !jwk.kid) continue;
		keys.set(jwk.kid, await importKey(jwk));
	}
	if (keys.size === 0) {
		throw new AccessRejected("jwks_empty", "no usable RSA signing keys");
	}

	jwksCache.set(url, { keys, fetchedAt: Date.now() });
	return keys;
}

/* ------------------------------------------------------------------ verify */

interface JwtHeader {
	alg?: string;
	kid?: string;
}

interface JwtPayload {
	iss?: string;
	aud?: string | string[];
	sub?: string;
	email?: string;
	exp?: number;
	nbf?: number;
	iat?: number;
	identity_nonce?: string;
}

/**
 * Verifies an Access assertion and returns who it says the person is.
 *
 * Throws `AccessRejected` for anything short of a complete pass. The checks
 * are ordered so that the cheap structural ones run before the signature, and
 * nothing in the token is believed until the signature has been checked.
 */
export async function verifyAccessToken(
	token: string,
	config: AccessConfig,
	options: {
		now?: Date;
		fetcher?: typeof fetch;
		clockSkewSeconds?: number;
	} = {},
): Promise<AccessIdentity> {
	const now = options.now ?? new Date();
	const skew = options.clockSkewSeconds ?? 60;
	const fetcher = options.fetcher ?? fetch;

	if (!config.teamDomain || !config.audience) {
		throw new AccessRejected("not_configured", "Access is not configured");
	}

	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new AccessRejected("malformed", "assertion is not a JWT");
	}
	const [rawHeader, rawPayload, rawSignature] = parts as [
		string,
		string,
		string,
	];

	let header: JwtHeader;
	let payload: JwtPayload;
	try {
		header = base64UrlToJson(rawHeader) as JwtHeader;
		payload = base64UrlToJson(rawPayload) as JwtPayload;
	} catch {
		throw new AccessRejected("malformed", "assertion could not be decoded");
	}

	// Algorithm confusion is the classic way into a JWT verifier: "none"
	// skips the signature, and HS256 invites the public key to be used as an
	// HMAC secret. Only one algorithm is ever accepted.
	if (header.alg !== "RS256") {
		throw new AccessRejected("bad_algorithm", `alg ${header.alg} is refused`);
	}
	if (!header.kid) {
		throw new AccessRejected("no_kid", "assertion names no signing key");
	}

	const keys = await signingKeys(config, fetcher);
	const key = keys.get(header.kid);
	if (!key) {
		throw new AccessRejected("unknown_kid", "assertion signed by unknown key");
	}

	const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
	const signature = base64UrlToBytes(rawSignature);
	const ok = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		signature as unknown as BufferSource,
		signed as unknown as BufferSource,
	);
	if (!ok)
		throw new AccessRejected("bad_signature", "signature does not match");

	// Only now is anything in the token worth reading.
	const issuer = `https://${config.teamDomain}.cloudflareaccess.com`;
	if (payload.iss !== issuer) {
		throw new AccessRejected("bad_issuer", "assertion is for another account");
	}

	// A token minted for a different Access application must not open this
	// one, even though both are signed by the same account key.
	const audiences = Array.isArray(payload.aud)
		? payload.aud
		: payload.aud
			? [payload.aud]
			: [];
	if (!audiences.includes(config.audience)) {
		throw new AccessRejected(
			"bad_audience",
			"assertion is for another application",
		);
	}

	const seconds = Math.floor(now.getTime() / 1000);
	if (typeof payload.exp !== "number" || payload.exp + skew < seconds) {
		throw new AccessRejected("expired", "assertion has expired");
	}
	if (typeof payload.nbf === "number" && payload.nbf - skew > seconds) {
		throw new AccessRejected("not_yet_valid", "assertion is not yet valid");
	}

	const email = (payload.email ?? "").trim().toLowerCase();
	if (!email) {
		throw new AccessRejected("no_email", "assertion carries no email");
	}
	if (!payload.sub) {
		throw new AccessRejected("no_subject", "assertion carries no subject");
	}

	return {
		email,
		subject: payload.sub,
		identityNonce: payload.identity_nonce,
		expiresAt: new Date(payload.exp * 1000),
	};
}

/** The assertion header Access sets, if present. */
export function accessTokenFrom(request: Request): string | null {
	return request.headers.get("Cf-Access-Jwt-Assertion");
}
