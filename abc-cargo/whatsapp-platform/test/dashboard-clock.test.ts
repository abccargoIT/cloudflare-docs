import { test } from "node:test";
import assert from "node:assert/strict";
import {
	describeMinutes,
	greeting,
	greetingBand,
	localMidnight,
	minutesSince,
	officeState,
	regionalDay,
	zoneOffsetMs,
} from "../src/dashboard/clock.ts";
import type { RegionConfig } from "../src/regions.ts";

function region(overrides: Partial<RegionConfig> = {}): RegionConfig {
	return {
		id: "uae",
		label: "UAE",
		phoneNumberId: "1",
		displayNumber: "+971800916",
		timezone: "Asia/Dubai",
		language: "en",
		businessHours: { days: [0, 1, 2, 3, 4], start: "09:00", end: "18:00" },
		...overrides,
	};
}

/* ------------------------------------------------------------------ zones */

test("the offset is read from the zone rather than held as a rule", () => {
	// Dubai is +04:00 all year; Riyadh +03:00; London moves.
	const summer = new Date("2026-07-01T12:00:00.000Z");
	const winter = new Date("2026-01-01T12:00:00.000Z");
	assert.equal(zoneOffsetMs(summer, "Asia/Dubai"), 4 * 3_600_000);
	assert.equal(zoneOffsetMs(winter, "Asia/Dubai"), 4 * 3_600_000);
	assert.equal(zoneOffsetMs(summer, "Asia/Riyadh"), 3 * 3_600_000);
	assert.equal(zoneOffsetMs(summer, "Europe/London"), 3_600_000);
	assert.equal(zoneOffsetMs(winter, "Europe/London"), 0);
});

test("milliseconds in the instant do not disturb the offset", () => {
	const odd = new Date("2026-07-01T12:00:00.750Z");
	assert.equal(zoneOffsetMs(odd, "Asia/Dubai"), 4 * 3_600_000);
});

/* -------------------------------------------------------- the region's day */

test("today means the region's today, not the server's", () => {
	// 22:30 UTC on 7 October is already 02:30 on the 8th in Dubai. A dashboard
	// counting from UTC midnight would show four and a half hours of Dubai's
	// day under the wrong date.
	const now = new Date("2026-10-07T22:30:00.000Z");
	assert.equal(
		localMidnight(now, "Asia/Dubai").toISOString(),
		"2026-10-07T20:00:00.000Z",
	);
	assert.equal(
		localMidnight(now, "Europe/London").toISOString(),
		"2026-10-06T23:00:00.000Z",
	);

	const day = regionalDay(now, "Asia/Dubai");
	assert.equal(day.from, "2026-10-07T20:00:00.000Z");
	assert.equal(day.to, "2026-10-08T20:00:00.000Z");
});

test("the day boundary survives a clock change", () => {
	// The UK puts its clocks back at 02:00 on 25 October 2026. Midnight that
	// morning is still BST, so local midnight is 23:00 UTC on the 24th; the
	// following midnight is GMT, so 00:00 UTC on the 26th. The day is 25 hours
	// long and both ends have to be right.
	const during = new Date("2026-10-25T10:00:00.000Z");
	const day = regionalDay(during, "Europe/London");
	assert.equal(day.from, "2026-10-24T23:00:00.000Z");
	assert.equal(day.to, "2026-10-26T00:00:00.000Z");
	assert.equal(
		(Date.parse(day.to) - Date.parse(day.from)) / 3_600_000,
		25,
		"the day the clocks go back is 25 hours long",
	);
});

test("the day boundary survives the start of a month", () => {
	const now = new Date("2026-10-31T21:00:00.000Z"); // 1 November in Dubai
	const day = regionalDay(now, "Asia/Dubai");
	assert.equal(day.from, "2026-10-31T20:00:00.000Z");
	assert.equal(day.to, "2026-11-01T20:00:00.000Z");
});

/* --------------------------------------------------------------- greeting */

test("the greeting follows the region's hours, not the server's", () => {
	// 06:00 UTC is mid-morning in Dubai and before dawn in London.
	const now = new Date("2026-10-08T06:00:00.000Z");
	assert.equal(greetingBand(now, "Asia/Dubai"), "morning");
	assert.equal(greetingBand(now, "Europe/London"), "morning");

	// 13:00 UTC: afternoon in London, evening in Dubai.
	const later = new Date("2026-10-08T13:00:00.000Z");
	assert.equal(greetingBand(later, "Europe/London"), "afternoon");
	assert.equal(greetingBand(later, "Asia/Dubai"), "evening");
});

test("a missing name gives a greeting without one, not a greeting with a gap", () => {
	const now = new Date("2026-10-08T06:00:00.000Z");
	assert.equal(
		greeting({ displayName: "Mariam", now, timezone: "Asia/Dubai" }),
		"Good morning, Mariam",
	);
	assert.equal(
		greeting({ displayName: "  ", now, timezone: "Asia/Dubai" }),
		"Good morning",
	);
	assert.equal(
		greeting({ displayName: null, now, timezone: "Asia/Dubai" }),
		"Good morning",
	);
});

/* ----------------------------------------------------------------- office */

test("the office strip says open, and when it closes", () => {
	// 10:30 Dubai on a Thursday, inside 09:00-18:00 Sunday to Thursday.
	const now = new Date("2026-10-08T06:30:00.000Z");
	const state = officeState(region(), now);
	assert.equal(state.open, true);
	assert.equal(state.localTime, "10:30");
	assert.equal(state.nextChange, "closes");
	assert.equal(state.changesInMinutes, 7 * 60 + 30);
});

test("before opening, the countdown is to today's opening", () => {
	// 07:00 Dubai on a Thursday, a working day.
	const now = new Date("2026-10-08T03:00:00.000Z");
	const state = officeState(region(), now);
	assert.equal(state.open, false);
	assert.equal(state.nextChange, "opens");
	assert.equal(state.changesInMinutes, 2 * 60);
});

test("after closing on the last working day, the countdown crosses the weekend", () => {
	// 19:00 Dubai on Thursday 8 October. Friday and Saturday are not working
	// days in this region, so the next opening is 09:00 on Sunday — 62 hours.
	const now = new Date("2026-10-08T15:00:00.000Z");
	const state = officeState(region(), now);
	assert.equal(state.open, false);
	assert.equal(state.nextChange, "opens");
	assert.equal(state.changesInMinutes, 62 * 60);
	assert.equal(describeMinutes(state.changesInMinutes), "2 days 14 hours");
});

test("a region with no working days says so instead of guessing", () => {
	const state = officeState(
		region({ businessHours: { days: [], start: "09:00", end: "18:00" } }),
		new Date(),
	);
	assert.equal(state.open, false);
	assert.equal(state.changesInMinutes, null);
	assert.equal(state.nextChange, null);
	assert.equal(describeMinutes(null), "unknown");
});

test("each region answers for its own working week", () => {
	// Friday 9 October. The UK works Monday to Friday, so London is open; the
	// UAE does not work Friday, so Dubai is shut until Sunday.
	const now = new Date("2026-10-09T10:00:00.000Z");
	const uk = officeState(
		region({
			id: "uk",
			label: "UK",
			timezone: "Europe/London",
			businessHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30" },
		}),
		now,
	);
	assert.equal(uk.open, true);
	assert.equal(officeState(region(), now).open, false);
});

/* ---------------------------------------------------------------- phrasing */

test("durations read the way somebody would say them", () => {
	assert.equal(describeMinutes(0), "now");
	assert.equal(describeMinutes(1), "1 minute");
	assert.equal(describeMinutes(45), "45 minutes");
	assert.equal(describeMinutes(60), "1 hour");
	assert.equal(describeMinutes(134), "2 hours 14 minutes");
	assert.equal(describeMinutes(1440), "1 day");
	assert.equal(describeMinutes(1500), "1 day 1 hour");
	// A negative is a clock disagreement, not a request for "-3 minutes ago".
	assert.equal(describeMinutes(-3), "now");
});

test("an unreadable timestamp gives no age rather than a wrong one", () => {
	const now = new Date("2026-10-08T12:00:00.000Z");
	assert.equal(minutesSince("2026-10-08T11:30:00.000Z", now), 30);
	assert.equal(minutesSince(null, now), null);
	assert.equal(minutesSince("nonsense", now), null);
	// A timestamp in the future reads as nothing elapsed, not as a negative wait.
	assert.equal(minutesSince("2026-10-08T12:05:00.000Z", now), 0);
});
