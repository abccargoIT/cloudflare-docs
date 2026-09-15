import { test } from "node:test";
import assert from "node:assert/strict";
import type { RegionConfig } from "../src/regions.ts";
import {
	addBusinessMinutes,
	isBreached,
	remainingMs,
	targetFor,
	ticketDueDates,
} from "../src/crm/sla.ts";

/** Sunday to Thursday, 08:00-18:00 Asia/Dubai (UTC+4, no daylight saving). */
const uae: RegionConfig = {
	id: "uae",
	label: "UAE",
	phoneNumberId: "111",
	displayNumber: "+971800916",
	timezone: "Asia/Dubai",
	language: "en",
	businessHours: { days: [0, 1, 2, 3, 4], start: "08:00", end: "18:00" },
};

/** Monday to Friday, 09:00-17:00 Europe/London. */
const uk: RegionConfig = {
	id: "uk",
	label: "UK",
	phoneNumberId: "333",
	displayNumber: "+447388800000",
	timezone: "Europe/London",
	language: "en",
	businessHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
};

test("inside business hours the clock runs in real time", () => {
	// Monday 2026-09-14 10:00 Asia/Dubai = 06:00Z
	const from = new Date("2026-09-14T06:00:00Z");
	const due = addBusinessMinutes(uae, from, 30);
	assert.equal(due.toISOString(), "2026-09-14T06:30:00.000Z");
});

test("a target set before opening starts at the opening bell", () => {
	// Monday 06:00 Asia/Dubai = 02:00Z, office opens 08:00 local = 04:00Z
	const from = new Date("2026-09-14T02:00:00Z");
	const due = addBusinessMinutes(uae, from, 30);
	assert.equal(due.toISOString(), "2026-09-14T04:30:00.000Z");
});

test("a target set after closing rolls to the next working morning", () => {
	// Monday 19:00 Asia/Dubai = 15:00Z. Next open Tuesday 08:00 = 04:00Z.
	const from = new Date("2026-09-14T15:00:00Z");
	const due = addBusinessMinutes(uae, from, 30);
	assert.equal(due.toISOString(), "2026-09-15T04:30:00.000Z");
});

test("the clock does not run over a non-working day", () => {
	// UAE calendar here is Sunday-Thursday, so Friday and Saturday are closed.
	// Thursday 2026-09-17 17:30 Asia/Dubai = 13:30Z, 60 minutes to run.
	// 30 minutes are left on Thursday; the rest resumes Sunday 08:00 local.
	const from = new Date("2026-09-17T13:30:00Z");
	const due = addBusinessMinutes(uae, from, 60);
	assert.equal(due.toISOString(), "2026-09-20T04:30:00.000Z");
});

test("a multi-day target lands on the correct working day", () => {
	// UK: Monday 2026-09-14 09:00 London = 08:00Z (BST). On an 8-hour
	// calendar, 24 business hours is exactly three working days, so the
	// target falls on Wednesday's closing bell — 17:00 London = 16:00Z.
	// Landing on the boundary is deliberate: the time remaining reaches zero
	// at the moment the office closes, not the following morning.
	const from = new Date("2026-09-14T08:00:00Z");
	const due = addBusinessMinutes(uk, from, 24 * 60);
	assert.equal(due.toISOString(), "2026-09-16T16:00:00.000Z");
});

test("a weekend is skipped entirely", () => {
	// UK: Friday 2026-09-18 16:30 London = 15:30Z, 60 minutes to run.
	// 30 minutes on Friday, the rest at Monday's opening.
	const from = new Date("2026-09-18T15:30:00Z");
	const due = addBusinessMinutes(uk, from, 60);
	assert.equal(due.toISOString(), "2026-09-21T08:30:00.000Z");
});

test("zero minutes returns the starting instant when the office is open", () => {
	const from = new Date("2026-09-14T06:00:00Z");
	assert.equal(
		addBusinessMinutes(uae, from, 0).toISOString(),
		from.toISOString(),
	);
});

test("priority shortens the target and never lengthens it", () => {
	const normal = targetFor("claim", "normal");
	const high = targetFor("claim", "high");
	const low = targetFor("claim", "low");
	assert.ok(high.firstResponseMinutes < normal.firstResponseMinutes);
	assert.equal(low.firstResponseMinutes, normal.firstResponseMinutes);
});

test("a target never collapses below the floor", () => {
	const urgent = targetFor("claim", "urgent");
	assert.ok(urgent.firstResponseMinutes >= 5);
	assert.ok(urgent.resolutionMinutes >= 15);
});

test("ticket due dates put first response before resolution", () => {
	const from = new Date("2026-09-14T06:00:00Z");
	const due = ticketDueDates(uae, "claim", "normal", from);
	assert.ok(
		Date.parse(due.firstResponseDueAt) < Date.parse(due.resolutionDueAt),
	);
});

test("a calendar with no working days is rejected rather than looping", () => {
	const broken: RegionConfig = {
		...uae,
		businessHours: { days: [], start: "08:00", end: "18:00" },
	};
	assert.throws(
		() => addBusinessMinutes(broken, new Date(), 30),
		/no working days/,
	);
});

test("business hours that end before they start are rejected", () => {
	const broken: RegionConfig = {
		...uae,
		businessHours: { days: [1], start: "18:00", end: "08:00" },
	};
	assert.throws(() => addBusinessMinutes(broken, new Date(), 30), /end after/);
});

test("negative minutes are rejected", () => {
	assert.throws(() => addBusinessMinutes(uae, new Date(), -1), /non-negative/);
});

test("breach detection reads the sign of the remaining time", () => {
	const now = new Date("2026-09-14T06:00:00Z");
	assert.equal(isBreached("2026-09-14T05:00:00Z", now), true);
	assert.equal(isBreached("2026-09-14T07:00:00Z", now), false);
	assert.equal(remainingMs("2026-09-14T07:00:00Z", now), 3_600_000);
});
