import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildAutoReply,
	describeDays,
	extractTrackingNumbers,
} from "../src/auto-reply.ts";
import type { RegionConfig } from "../src/regions.ts";

const region: RegionConfig = {
	id: "uae",
	label: "UAE",
	phoneNumberId: "111",
	displayNumber: "+971500000000",
	timezone: "Asia/Dubai",
	language: "en",
	businessHours: { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "18:00" },
};

test("extracts and normalises tracking references", () => {
	assert.deepEqual(
		extractTrackingNumbers(
			"Where is ABC-1234567 and abc 1234567? Also XY12345678.",
		),
		["ABC1234567", "XY12345678"],
	);
	assert.deepEqual(extractTrackingNumbers("no refs here 12"), []);
	assert.deepEqual(extractTrackingNumbers(undefined), []);
});

test("outside-hours reply mentions hours and the reference", () => {
	const text = buildAutoReply({
		region,
		reason: "outside-hours",
		contactName: "Fatima",
		inboundText: "Status of ABC1234567 please",
		trackingUrl: "https://example.invalid/track",
	});
	assert.match(text, /Hello Fatima,/);
	assert.match(text, /ABC1234567/);
	assert.match(text, /09:00 to 18:00/);
	assert.match(
		text,
		/Monday, Tuesday, Wednesday, Thursday, Friday and Saturday/,
	);
	assert.match(text, /https:\/\/example\.invalid\/track/);
});

test("no-agents reply does not mention working hours", () => {
	const text = buildAutoReply({ region, reason: "no-agents-online" });
	assert.match(text, /Hello,/);
	assert.match(text, /assisting other customers/);
	assert.doesNotMatch(text, /Working hours/);
});

test("describeDays formats ranges of days", () => {
	assert.equal(describeDays([0, 1, 2, 3, 4, 5, 6]), "all days");
	assert.equal(describeDays([1]), "Monday");
	assert.equal(describeDays([5, 1]), "Monday and Friday");
});
