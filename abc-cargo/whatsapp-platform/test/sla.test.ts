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

/* ------------------------------------------------- crossing a closing time */

/*
 * These cover a defect found on 9 October 2026 by round-tripping
 * addBusinessMinutes against businessMinutesBetween: a target that used up
 * the rest of the day and then needed more advanced the cursor from the wrong
 * base, so every due date crossing a close landed hours too early. 780
 * minutes landed correctly at 23:00 and 781 landed at 19:01 the same evening.
 */

test("one minute more of target never moves a due date earlier", () => {
	// The cleanest statement of the defect: the function must be monotonic.
	const from = new Date("2026-09-14T06:00:00Z"); // Monday 10:00 Dubai
	let previous = addBusinessMinutes(uae, from, 1).getTime();
	for (let minutes = 2; minutes <= 2000; minutes += 1) {
		const current = addBusinessMinutes(uae, from, minutes).getTime();
		assert.ok(current >= previous, `+${minutes} landed before +${minutes - 1}`);
		previous = current;
	}
});

test("a target that exactly fills the day lands at closing time", () => {
	// Monday 10:00 Dubai, eight hours left before 18:00.
	const due = addBusinessMinutes(uae, new Date("2026-09-14T06:00:00Z"), 480);
	assert.equal(due.toISOString(), "2026-09-14T14:00:00.000Z", "Monday 18:00");
});

test("a target one minute past the day rolls to the next opening", () => {
	const due = addBusinessMinutes(uae, new Date("2026-09-14T06:00:00Z"), 481);
	assert.equal(
		due.toISOString(),
		"2026-09-15T04:01:00.000Z",
		"Tuesday 08:01 Dubai, not Monday afternoon",
	);
});

test("a 24-hour target on a 10-hour calendar takes more than two days", () => {
	// The case that matters operationally: the default resolution target for
	// a billing or documentation ticket. 480 minutes left on Monday, a full
	// 600 on Tuesday, the remaining 360 on Wednesday morning.
	const due = addBusinessMinutes(
		uae,
		new Date("2026-09-14T06:00:00Z"),
		24 * 60,
	);
	assert.equal(
		due.toISOString(),
		"2026-09-16T10:00:00.000Z",
		"Wednesday 14:00",
	);
});

test("a target spanning the weekend skips the closed days", () => {
	// Thursday 2026-09-17 17:00 Dubai (13:00Z), one hour before closing.
	// Friday and Saturday are closed, so the second hour falls on Sunday.
	const due = addBusinessMinutes(uae, new Date("2026-09-17T13:00:00Z"), 120);
	assert.equal(due.toISOString(), "2026-09-20T05:00:00.000Z", "Sunday 09:00");
});
