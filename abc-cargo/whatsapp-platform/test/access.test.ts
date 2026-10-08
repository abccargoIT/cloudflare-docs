import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
	AccessRejected,
	accessTokenFrom,
	clearKeyCache,
	verifyAccessToken,
	type AccessConfig,
} from "../src/auth/access.ts";

const CONFIG: AccessConfig = {
	teamDomain: "abccargo",
	audience: "aud-engage-console",
};
const ISSUER = "https://abccargo.cloudflareaccess.com";
const NOW = new Date("2026-10-08T12:00:00Z");

let keyPair: CryptoKeyPair;
let otherPair: CryptoKeyPair;
let jwks: { keys: unknown[] };

function b64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
	return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function generate(): Promise<CryptoKeyPair> {
	return (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
}

/** Mints an assertion the way Access would, so the happy path is real. */
async function mint(
	payload: Record<string, unknown> = {},
	options: { kid?: string; alg?: string; signWith?: CryptoKey } = {},
): Promise<string> {
	const header = { alg: options.alg ?? "RS256", kid: options.kid ?? "key-1" };
	const body = {
		iss: ISSUER,
		aud: CONFIG.audience,
		sub: "subject-123",
		email: "Mariam@ABCCargo.invalid",
		iat: Math.floor(NOW.getTime() / 1000) - 60,
		exp: Math.floor(NOW.getTime() / 1000) + 3600,
		...payload,
	};
	const signingInput = `${encodeJson(header)}.${encodeJson(body)}`;
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		options.signWith ?? keyPair.privateKey,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

function fetcherFor(body: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
}

async function verify(token: string, fetcher = fetcherFor(jwks)) {
	return verifyAccessToken(token, CONFIG, { now: NOW, fetcher });
}

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "NO_REJECTION";
	} catch (error) {
		assert.ok(error instanceof AccessRejected, String(error));
		return error.code;
	}
}

before(async () => {
	keyPair = await generate();
	otherPair = await generate();
	const pub = (await crypto.subtle.exportKey(
		"jwk",
		keyPair.publicKey,
	)) as JsonWebKey;
	jwks = {
		keys: [{ ...pub, kid: "key-1", kty: "RSA", alg: "RS256", use: "sig" }],
	};
});

/* ------------------------------------------------------------- happy path */

test("accepts an assertion Access actually signed", async () => {
	clearKeyCache();
	const identity = await verify(await mint());
	assert.equal(identity.email, "mariam@abccargo.invalid"); // lower-cased
	assert.equal(identity.subject, "subject-123");
	assert.equal(identity.expiresAt.getTime(), NOW.getTime() + 3600_000);
});

test("accepts an audience list that contains ours", async () => {
	clearKeyCache();
	const identity = await verify(
		await mint({ aud: ["someone-else", CONFIG.audience] }),
	);
	assert.equal(identity.email, "mariam@abccargo.invalid");
});

/* ------------------------------------------------------- forgery and abuse */

test("refuses alg none and alg HS256", async () => {
	// The classic ways into a JWT verifier: skip the signature entirely, or
	// get the public key used as an HMAC secret.
	clearKeyCache();
	assert.equal(
		await rejectionCode(verify(await mint({}, { alg: "none" }))),
		"bad_algorithm",
	);
	clearKeyCache();
	assert.equal(
		await rejectionCode(verify(await mint({}, { alg: "HS256" }))),
		"bad_algorithm",
	);
});

test("refuses an assertion signed by a key that is not the account's", async () => {
	clearKeyCache();
	const forged = await mint({}, { signWith: otherPair.privateKey });
	assert.equal(await rejectionCode(verify(forged)), "bad_signature");
});

test("refuses a tampered payload", async () => {
	clearKeyCache();
	const token = await mint();
	const [header, , signature] = token.split(".") as [string, string, string];
	const swapped = encodeJson({
		iss: ISSUER,
		aud: CONFIG.audience,
		sub: "subject-123",
		email: "attacker@elsewhere.invalid",
		exp: Math.floor(NOW.getTime() / 1000) + 3600,
	});
	assert.equal(
		await rejectionCode(verify(`${header}.${swapped}.${signature}`)),
		"bad_signature",
	);
});

test("refuses an unknown signing key id", async () => {
	clearKeyCache();
	assert.equal(
		await rejectionCode(verify(await mint({}, { kid: "key-9" }))),
		"unknown_kid",
	);
});

test("refuses a token minted for another Access application", async () => {
	// Same account, same signing key, different application. It must not open
	// this one.
	clearKeyCache();
	assert.equal(
		await rejectionCode(verify(await mint({ aud: "aud-some-other-app" }))),
		"bad_audience",
	);
	clearKeyCache();
	assert.equal(
		await rejectionCode(verify(await mint({ aud: [] }))),
		"bad_audience",
	);
});

test("refuses a token from another Cloudflare account", async () => {
	clearKeyCache();
	assert.equal(
		await rejectionCode(
			verify(await mint({ iss: "https://someone-else.cloudflareaccess.com" })),
		),
		"bad_issuer",
	);
});

/* ------------------------------------------------------------------- time */

test("refuses an expired assertion, allowing a minute of clock skew", async () => {
	clearKeyCache();
	const seconds = Math.floor(NOW.getTime() / 1000);
	assert.equal(
		await rejectionCode(verify(await mint({ exp: seconds - 3600 }))),
		"expired",
	);
	// Thirty seconds past expiry is tolerated; the clocks are not the same.
	clearKeyCache();
	const identity = await verify(await mint({ exp: seconds - 30 }));
	assert.equal(identity.email, "mariam@abccargo.invalid");
});

test("refuses an assertion that is not yet valid, and one with no expiry", async () => {
	clearKeyCache();
	const seconds = Math.floor(NOW.getTime() / 1000);
	assert.equal(
		await rejectionCode(verify(await mint({ nbf: seconds + 3600 }))),
		"not_yet_valid",
	);
	clearKeyCache();
	assert.equal(
		await rejectionCode(verify(await mint({ exp: undefined }))),
		"expired",
	);
});

/* --------------------------------------------------------------- structure */

test("refuses malformed input rather than guessing", async () => {
	clearKeyCache();
	for (const bad of ["", "not-a-jwt", "a.b", "a.b.c.d"]) {
		assert.equal(await rejectionCode(verify(bad)), "malformed");
	}
	clearKeyCache();
	assert.equal(await rejectionCode(verify("!!!.!!!.!!!")), "malformed");
});

test("refuses an assertion with no email or no subject", async () => {
	clearKeyCache();
	assert.equal(
		await rejectionCode(verify(await mint({ email: "   " }))),
		"no_email",
	);
	clearKeyCache();
	assert.equal(
		await rejectionCode(verify(await mint({ sub: undefined }))),
		"no_subject",
	);
});

/* ----------------------------------------------------------- configuration */

test("fails closed when Access is not configured", async () => {
	clearKeyCache();
	const code = await rejectionCode(
		verifyAccessToken(
			await mint(),
			{ teamDomain: "", audience: "" },
			{
				now: NOW,
				fetcher: fetcherFor(jwks),
			},
		),
	);
	assert.equal(code, "not_configured");
});

test("fails closed when the signing keys cannot be fetched", async () => {
	clearKeyCache();
	assert.equal(
		await rejectionCode(verify(await mint(), fetcherFor({}, 500))),
		"jwks_unavailable",
	);
	clearKeyCache();
	assert.equal(
		await rejectionCode(verify(await mint(), fetcherFor({ keys: [] }))),
		"jwks_empty",
	);
});

test("caches the signing keys rather than fetching per request", async () => {
	clearKeyCache();
	let fetches = 0;
	const counting = (async () => {
		fetches++;
		return new Response(JSON.stringify(jwks), {
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;

	await verify(await mint(), counting);
	await verify(await mint(), counting);
	await verify(await mint(), counting);
	assert.equal(fetches, 1);
});

/* ------------------------------------------------------------------ header */

test("reads the assertion header, and ignores the email header", async () => {
	// The email header is trivially forgeable on a public hostname. Nothing
	// in this module reads it, and this test exists to keep it that way.
	const request = new Request("https://engage.invalid/api/conversations", {
		headers: {
			"Cf-Access-Jwt-Assertion": "a.b.c",
			"Cf-Access-Authenticated-User-Email": "attacker@elsewhere.invalid",
		},
	});
	assert.equal(accessTokenFrom(request), "a.b.c");

	const source = await import("node:fs/promises").then((fs) =>
		fs.readFile(new URL("../src/auth/access.ts", import.meta.url), "utf8"),
	);
	assert.ok(
		!/headers\.get\(\s*["']Cf-Access-Authenticated-User-Email/i.test(source),
		"access.ts must never read the forgeable email header",
	);
});
