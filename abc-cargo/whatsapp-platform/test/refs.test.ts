import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildRef,
	classifyRef,
	isRef,
	regionCode,
	shortCode,
} from "../src/crm/refs.ts";

test("references are padded and prefixed by kind", () => {
	assert.equal(buildRef("lead", 1), "L-00001");
	assert.equal(buildRef("quotation", 42), "Q-00042");
	assert.equal(buildRef("ticket", 4402), "T-04402");
});

test("a booking reference carries its region", () => {
	assert.equal(buildRef("booking", 88210, "uae"), "ABC-UAE-088210");
	assert.equal(buildRef("booking", 1, "ksa"), "ABC-KSA-000001");
});

test("a booking reference needs a region", () => {
	assert.throws(() => buildRef("booking", 1), /need a region/);
});

test("sequences must be positive integers", () => {
	assert.throws(() => buildRef("lead", 0), /positive integer/);
	assert.throws(() => buildRef("lead", -3), /positive integer/);
	assert.throws(() => buildRef("lead", 1.5), /positive integer/);
});

test("references stay readable past the padding width", () => {
	assert.equal(buildRef("lead", 123456), "L-123456");
});

test("region codes are always three letters", () => {
	assert.equal(regionCode("uae"), "UAE");
	assert.equal(regionCode("uk"), "UKX");
	assert.equal(regionCode("region-2"), "REG");
	assert.equal(regionCode("123"), "GEN");
});

test("references are recognised by kind", () => {
	assert.ok(isRef("lead", "L-00001"));
	assert.ok(isRef("booking", "ABC-UAE-088210"));
	assert.equal(isRef("lead", "Q-00001"), false);
	assert.equal(classifyRef("T-04402"), "ticket");
	assert.equal(classifyRef("ABC-KSA-000001"), "booking");
	assert.equal(classifyRef("nonsense"), null);
});

test("short codes avoid characters that are misread", () => {
	// I/1, O/0, S/5, Z/2 and B/8 must never appear.
	let seq = 0;
	const deterministic = () => {
		const v = seq / 64;
		seq = (seq + 1) % 64;
		return v;
	};
	for (let i = 0; i < 200; i++) {
		const code = shortCode(8, deterministic);
		assert.equal(code.length, 8);
		assert.equal(/[IOSZB1052]/.test(code), false, `bad char in ${code}`);
	}
});

test("a short code needs a positive length", () => {
	assert.throws(() => shortCode(0), /at least 1/);
});
