import { test } from "node:test";
import assert from "node:assert/strict";
import {
	computeHmacSha256Hex,
	timingSafeEqual,
	verifyMetaSignature,
} from "../src/whatsapp/signature.ts";

const secret = "test-app-secret";
const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

test("accepts a correctly signed body", async () => {
	const hex = await computeHmacSha256Hex(secret, body);
	assert.equal(await verifyMetaSignature(body, `sha256=${hex}`, secret), true);
});

test("rejects a tampered body", async () => {
	const hex = await computeHmacSha256Hex(secret, body);
	assert.equal(
		await verifyMetaSignature(body + " ", `sha256=${hex}`, secret),
		false,
	);
});

test("rejects a missing or malformed header", async () => {
	assert.equal(await verifyMetaSignature(body, null, secret), false);
	assert.equal(await verifyMetaSignature(body, "sha1=abc", secret), false);
	assert.equal(await verifyMetaSignature(body, "sha256=", secret), false);
});

test("rejects when the secret is empty", async () => {
	const hex = await computeHmacSha256Hex(secret, body);
	assert.equal(await verifyMetaSignature(body, `sha256=${hex}`, ""), false);
});

test("timingSafeEqual compares whole strings", () => {
	assert.equal(timingSafeEqual("abc", "abc"), true);
	assert.equal(timingSafeEqual("abc", "abd"), false);
	assert.equal(timingSafeEqual("abc", "ab"), false);
});
