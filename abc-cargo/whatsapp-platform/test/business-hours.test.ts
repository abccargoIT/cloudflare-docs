import { test } from "node:test";
import assert from "node:assert/strict";
import { isWithinBusinessHours, localClock } from "../src/business-hours.ts";
import type { RegionConfig } from "../src/regions.ts";

const uae: RegionConfig = {
	id: "uae",
	label: "UAE",
	phoneNumberId: "111",
	displayNumber: "+971500000000",
	timezone: "Asia/Dubai",
	language: "en",
	// Monday to Saturday, 09:00 to 18:00 Gulf Standard Time (UTC+4)
	businessHours: { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "18:00" },
};

test("localClock converts to the region timezone", () => {
	// 2026-09-02 is a Wednesday. 06:30 UTC = 10:30 in Dubai.
	const { weekday, minutes } = localClock(
		new Date("2026-09-02T06:30:00Z"),
		"Asia/Dubai",
	);
	assert.equal(weekday, 3);
	assert.equal(minutes, 10 * 60 + 30);
});

test("inside hours on a working day", () => {
	assert.equal(
		isWithinBusinessHours(uae, new Date("2026-09-02T06:30:00Z")),
		true,
	);
});

test("before opening and after closing", () => {
	// 04:59 UTC = 08:59 Dubai
	assert.equal(
		isWithinBusinessHours(uae, new Date("2026-09-02T04:59:00Z")),
		false,
	);
	// 14:00 UTC = 18:00 Dubai (end is exclusive)
	assert.equal(
		isWithinBusinessHours(uae, new Date("2026-09-02T14:00:00Z")),
		false,
	);
	// 13:59 UTC = 17:59 Dubai
	assert.equal(
		isWithinBusinessHours(uae, new Date("2026-09-02T13:59:00Z")),
		true,
	);
});

test("closed on a non-working day", () => {
	// 2026-09-06 is a Sunday.
	assert.equal(
		isWithinBusinessHours(uae, new Date("2026-09-06T08:00:00Z")),
		false,
	);
});

test("day boundary respects the timezone, not UTC", () => {
	// Saturday 2026-09-05 23:30 UTC is Sunday 03:30 in Dubai: closed.
	assert.equal(
		isWithinBusinessHours(uae, new Date("2026-09-05T23:30:00Z")),
		false,
	);
});
