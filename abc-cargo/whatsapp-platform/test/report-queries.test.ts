import { test } from "node:test";
import assert from "node:assert/strict";
import {
	AUTOMATED_SENDERS,
	MAX_REPORT_DAYS,
	clampWindow,
	daysIn,
} from "../src/crm/report-queries.ts";

test("every UTC day the window touches is listed, oldest first", () => {
	assert.deepEqual(
		daysIn({ from: "2026-09-28T22:00:00Z", to: "2026-10-01T03:00:00Z" }),
		["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"],
	);
});

test("a backwards or unreadable window has no days", () => {
	assert.deepEqual(
		daysIn({ from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" }),
		[],
	);
	assert.deepEqual(
		daysIn({ from: "nonsense", to: "2026-10-01T00:00:00Z" }),
		[],
	);
});

test("a long window is cut to the most recent days, keeping its end", () => {
	const window = clampWindow({
		from: "2025-01-01T00:00:00Z",
		to: "2026-10-09T12:00:00Z",
	});
	assert.equal(window.to, "2026-10-09T12:00:00Z");
	const days = daysIn(window);
	assert.equal(days.length, MAX_REPORT_DAYS);
	assert.equal(days.at(-1), "2026-10-09");
	// The clamped window starts at the first day listed, so no report in one
	// export covers a day another leaves out.
	assert.equal(window.from.slice(0, 10), days[0]);
});

test("a short window is left exactly as asked", () => {
	const window = { from: "2026-10-01T00:00:00Z", to: "2026-10-09T00:00:00Z" };
	assert.deepEqual(clampWindow(window), window);
});

test("survey questions and bot messages never count as a person replying", () => {
	for (const sender of ["bot", "auto", "system", "survey"]) {
		assert.ok(
			(AUTOMATED_SENDERS as readonly string[]).includes(sender),
			sender,
		);
	}
});
