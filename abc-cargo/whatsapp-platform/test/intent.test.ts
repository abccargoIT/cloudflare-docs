import { test } from "node:test";
import assert from "node:assert/strict";
import {
	classifyIntent,
	outcomeFor,
	ticketTypeFor,
} from "../src/crm/intent.ts";

test("recognises a rate enquiry", () => {
	const r = classifyIntent("How much to send 40 kg to Chennai?");
	assert.equal(r.intent, "rate");
	assert.ok(r.confidence > 0);
});

test("recognises an Arabic rate enquiry", () => {
	const r = classifyIntent("أحتاج سعر شحن إلى مانيلا");
	assert.equal(r.intent, "rate");
});

test("a claim outranks the tracking words in the same message", () => {
	// The customer is tracking and complaining at once. Routing this to a
	// sales queue instead of a claim is the expensive mistake.
	const r = classifyIntent(
		"Where is my shipment ABC-471-88210, one carton arrived damaged",
	);
	assert.equal(r.intent, "claim");
	assert.deepEqual(r.references, ["ABC47188210"]);
});

test("recognises an Arabic claim", () => {
	assert.equal(classifyIntent("الشحنة تالفة").intent, "claim");
});

test("a bare reference is a tracking request", () => {
	const r = classifyIntent("ABC-471-88210");
	assert.equal(r.intent, "track");
	assert.deepEqual(r.references, ["ABC47188210"]);
});

test("a reference lifts confidence on a tracking request", () => {
	const withRef = classifyIntent("track ABC-471-88210");
	const withoutRef = classifyIntent("track my shipment please");
	assert.ok(withRef.confidence > withoutRef.confidence);
});

test("a greeting only counts when it is the whole message", () => {
	assert.equal(classifyIntent("hi").intent, "greeting");
	assert.equal(
		classifyIntent("hi, my invoice shows the wrong duty charge").intent,
		"billing",
	);
});

test("does not match a keyword inside a longer word", () => {
	// "hi" must not fire inside "shipping".
	assert.notEqual(classifyIntent("shipping department").intent, "greeting");
});

test("empty and whitespace messages are unknown", () => {
	assert.equal(classifyIntent(undefined).intent, "unknown");
	assert.equal(classifyIntent("   ").intent, "unknown");
});

test("booking changes are recognised", () => {
	assert.equal(
		classifyIntent("Can I change the address on my booking?").intent,
		"booking_change",
	);
});

test("intents map to the record they should create", () => {
	assert.equal(outcomeFor("rate"), "lead");
	assert.equal(outcomeFor("claim"), "ticket");
	assert.equal(outcomeFor("billing"), "ticket");
	assert.equal(outcomeFor("track"), null);
	assert.equal(outcomeFor("greeting"), null);
});

test("ticket intents map to a ticket type", () => {
	assert.equal(ticketTypeFor("claim"), "claim");
	assert.equal(ticketTypeFor("billing"), "billing");
	assert.equal(ticketTypeFor("booking_change"), "delivery");
	assert.equal(ticketTypeFor("track"), "general");
});
