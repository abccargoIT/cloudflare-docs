import { test } from "node:test";
import assert from "node:assert/strict";
import {
	addInto,
	defaultWindow,
	parseWindow,
	type RegionSummary,
} from "../src/crm/reports.ts";

const NOW = new Date("2026-10-08T12:00:00Z");

function region(
	id: string,
	overrides: Partial<RegionSummary> = {},
): RegionSummary {
	return {
		regionId: id,
		conversations: {
			open: 0,
			pending: 0,
			resolved: 0,
			unassigned: 0,
			firstResponseOverdue: 0,
		},
		tickets: {
			open: 0,
			overdueFirstResponse: 0,
			overdueResolution: 0,
			byType: {},
		},
		leads: { open: 0, won: 0, lost: 0 },
		bookings: { active: 0, delivered: 0 },
		calls: { inbound: 0, outbound: 0 },
		...overrides,
	};
}

/* ------------------------------------------------------------------ window */

test("the default window is the last fourteen days", () => {
	// Fourteen rather than seven, so a fortnightly pattern is visible and one
	// quiet week does not read as a trend.
	const window = defaultWindow(NOW);
	assert.equal(window.to, "2026-10-08T12:00:00.000Z");
	assert.equal(window.from, "2026-09-24T12:00:00.000Z");
});

test("a valid requested window is used as given", () => {
	const window = parseWindow(
		"2026-10-01T00:00:00Z",
		"2026-10-07T00:00:00Z",
		NOW,
	);
	assert.equal(window.from, "2026-10-01T00:00:00.000Z");
	assert.equal(window.to, "2026-10-07T00:00:00.000Z");
});

test("a nonsensical window falls back rather than returning nothing", () => {
	const fallback = defaultWindow(NOW);
	// Backwards: a mistake, not a request for an empty report.
	assert.deepEqual(
		parseWindow("2026-10-07T00:00:00Z", "2026-10-01T00:00:00Z", NOW),
		fallback,
	);
	// Equal ends would report on an instant.
	assert.deepEqual(
		parseWindow("2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", NOW),
		fallback,
	);
	assert.deepEqual(parseWindow("not-a-date", "also-not", NOW), fallback);
	assert.deepEqual(parseWindow(null, null, NOW), fallback);
	// Half a window is no window.
	assert.deepEqual(parseWindow("2026-10-01T00:00:00Z", null, NOW), fallback);
});

/* ------------------------------------------------------------------ totals */

test("totals add every region together, including ticket types", () => {
	const total = region("");
	addInto(
		total,
		region("uae", {
			conversations: {
				open: 5,
				pending: 2,
				resolved: 11,
				unassigned: 3,
				firstResponseOverdue: 1,
			},
			tickets: {
				open: 4,
				overdueFirstResponse: 1,
				overdueResolution: 0,
				byType: { claim: 3, delay: 1 },
			},
			leads: { open: 7, won: 2, lost: 1 },
			bookings: { active: 9, delivered: 20 },
			calls: { inbound: 12, outbound: 4 },
		}),
	);
	addInto(
		total,
		region("ksa", {
			conversations: {
				open: 1,
				pending: 0,
				resolved: 3,
				unassigned: 1,
				firstResponseOverdue: 2,
			},
			tickets: {
				open: 2,
				overdueFirstResponse: 0,
				overdueResolution: 1,
				// A type the first region also had, and one it did not.
				byType: { claim: 1, billing: 1 },
			},
			leads: { open: 2, won: 1, lost: 0 },
			bookings: { active: 1, delivered: 2 },
			calls: { inbound: 3, outbound: 1 },
		}),
	);

	assert.equal(total.conversations.open, 6);
	assert.equal(total.conversations.firstResponseOverdue, 3);
	assert.equal(total.tickets.open, 6);
	assert.equal(total.tickets.overdueFirstResponse, 1);
	assert.equal(total.tickets.overdueResolution, 1);
	// Shared types add; a type only one region has still appears.
	assert.deepEqual(total.tickets.byType, { claim: 4, delay: 1, billing: 1 });
	assert.deepEqual(total.leads, { open: 9, won: 3, lost: 1 });
	assert.deepEqual(total.bookings, { active: 10, delivered: 22 });
	assert.deepEqual(total.calls, { inbound: 15, outbound: 5 });
});

test("adding nothing leaves the totals alone", () => {
	const total = region("");
	addInto(total, region("uk"));
	assert.equal(total.conversations.open, 0);
	assert.deepEqual(total.tickets.byType, {});
});
