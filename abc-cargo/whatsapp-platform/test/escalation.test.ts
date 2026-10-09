import { test } from "node:test";
import assert from "node:assert/strict";
import type { RegionConfig } from "../src/regions.ts";
import type { BotSession, BotStep } from "../src/bots/types.ts";
import { addBusinessMinutes } from "../src/crm/sla.ts";
import {
	DEFAULT_FALLBACK_MINUTES,
	TIER2_AFTER_MINUTES,
	applyFallback,
	businessMinutesBetween,
	checkFallback,
} from "../src/bots/escalation.ts";

/** Sunday-Thursday, 08:00-23:00 Asia/Dubai (UTC+4, no DST). */
const uae: RegionConfig = {
	id: "uae",
	label: "UAE",
	phoneNumberId: "uae-number",
	displayNumber: "+971800916",
	timezone: "Asia/Dubai",
	language: "en",
	businessHours: { days: [0, 1, 2, 3, 4], start: "08:00", end: "23:00" },
};

/** Monday-Friday, 09:00-17:00 Europe/London — has DST, on purpose. */
const uk: RegionConfig = {
	id: "uk",
	label: "UK",
	phoneNumberId: "uk-number",
	displayNumber: "+447388800000",
	timezone: "Europe/London",
	language: "en",
	businessHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
};

function session(over: Partial<BotSession> = {}): BotSession {
	return {
		flowId: "f1",
		flowVersion: 1,
		stepId: "ask-ref",
		slots: { reference: "ABC-UAE-088210" },
		invalidReplies: 0,
		turns: 2,
		startedAt: "2026-09-14T06:00:00Z",
		updatedAt: "2026-09-14T06:00:00Z",
		endedAt: null,
		endedReason: null,
		...over,
	};
}

const askStep: BotStep = {
	id: "ask-ref",
	kind: "ask",
	text: "Which reference?",
	slot: "reference",
	next: "done",
};

/* ------------------------------------------------- businessMinutesBetween */

test("inside open hours it is ordinary elapsed time", () => {
	// Monday 2026-09-14 10:00 Dubai = 06:00Z, to 10:30 Dubai.
	const n = businessMinutesBetween(
		uae,
		new Date("2026-09-14T06:00:00Z"),
		new Date("2026-09-14T06:30:00Z"),
	);
	assert.equal(n, 30);
});

test("the clock pauses overnight", () => {
	// Monday 22:55 Dubai (18:55Z) to Tuesday 08:05 Dubai (04:05Z).
	// Open until 23:00 = 5 minutes, then from 08:00 = 5 minutes. Total 10.
	const n = businessMinutesBetween(
		uae,
		new Date("2026-09-14T18:55:00Z"),
		new Date("2026-09-15T04:05:00Z"),
	);
	assert.equal(n, 10, "not the nine hours on the wall");
});

test("closed days contribute nothing", () => {
	// Thursday 2026-09-17 22:00 Dubai to Sunday 2026-09-20 09:00 Dubai.
	// Thu 22:00-23:00 = 60. Fri + Sat closed. Sun 08:00-09:00 = 60.
	const n = businessMinutesBetween(
		uae,
		new Date("2026-09-17T18:00:00Z"),
		new Date("2026-09-20T05:00:00Z"),
	);
	assert.equal(n, 120);
});

test("a whole open day is the day's capacity", () => {
	const n = businessMinutesBetween(
		uae,
		new Date("2026-09-13T00:00:00Z"),
		new Date("2026-09-14T00:00:00Z"),
	);
	assert.equal(n, 15 * 60, "08:00-23:00 is fifteen hours");
});

test("it is the inverse of addBusinessMinutes", () => {
	// The strongest check available: walk forward with one function, measure
	// the gap with the other, and the answer must come back.
	for (const region of [uae, uk]) {
		for (const minutes of [5, 30, 120, 480, 1000, 5000]) {
			for (const startIso of [
				"2026-09-14T06:00:00Z",
				"2026-09-17T18:30:00Z",
				"2026-10-24T15:00:00Z", // UK clocks go back 2026-10-25
			]) {
				const from = new Date(startIso);
				const to = addBusinessMinutes(region, from, minutes);
				const measured = businessMinutesBetween(region, from, to);
				assert.ok(
					Math.abs(measured - minutes) <= 1,
					`${region.id} ${startIso} +${minutes} measured ${measured}`,
				);
			}
		}
	}
});

test("a backwards or equal interval is zero, never negative", () => {
	const t = new Date("2026-09-14T06:00:00Z");
	assert.equal(businessMinutesBetween(uae, t, t), 0);
	assert.equal(
		businessMinutesBetween(uae, t, new Date("2026-09-13T06:00:00Z")),
		0,
		"a negative idle time would silently disable the fallback",
	);
});

test("a calendar with no working days measures nothing rather than looping", () => {
	const closed: RegionConfig = {
		...uae,
		businessHours: { days: [], start: "08:00", end: "23:00" },
	};
	assert.equal(
		businessMinutesBetween(
			closed,
			new Date("2026-09-14T06:00:00Z"),
			new Date("2026-09-21T06:00:00Z"),
		),
		0,
	);
});

/* --------------------------------------------------------- the fallback */

test("a customer silent past the threshold goes to a person", () => {
	const now = new Date("2026-09-14T06:11:00Z"); // 11 business minutes later
	const d = checkFallback({
		session: session(),
		step: askStep,
		region: uae,
		now,
	});
	assert.equal(d.escalate, true);
	assert.equal(d.tier, "tier1");
	assert.equal(d.reason, "silent_too_long");
	assert.equal(d.silentMinutes, 11);
	assert.equal(d.remainingMinutes, 0);
});

test("inside the threshold it waits, and says how much longer", () => {
	const now = new Date("2026-09-14T06:04:00Z");
	const d = checkFallback({
		session: session(),
		step: askStep,
		region: uae,
		now,
	});
	assert.equal(d.escalate, false);
	assert.equal(d.reason, "waiting");
	assert.equal(d.silentMinutes, 4);
	assert.equal(d.remainingMinutes, DEFAULT_FALLBACK_MINUTES - 4);
});

test("the threshold does not elapse while the office is shut", () => {
	// Asked at 22:55 Dubai; swept at 23:30 Dubai, half an hour later on the
	// wall but only five business minutes.
	const d = checkFallback({
		session: session({ updatedAt: "2026-09-14T18:55:00Z" }),
		step: askStep,
		region: uae,
		now: new Date("2026-09-14T19:30:00Z"),
	});
	assert.equal(d.escalate, false, "nobody is there to pick it up");
	assert.equal(d.silentMinutes, 5);
});

test("and it resumes when the office opens", () => {
	const d = checkFallback({
		session: session({ updatedAt: "2026-09-14T18:55:00Z" }),
		step: askStep,
		region: uae,
		now: new Date("2026-09-15T04:06:00Z"), // 08:06 Dubai next morning
	});
	assert.equal(d.escalate, true);
	assert.equal(d.silentMinutes, 11);
});

test("a step's own fallbackMinutes beats the default", () => {
	const impatient: BotStep = { ...askStep, kind: "ask", fallbackMinutes: 3 };
	const d = checkFallback({
		session: session(),
		step: impatient,
		region: uae,
		now: new Date("2026-09-14T06:04:00Z"),
	});
	assert.equal(d.escalate, true, "3-minute step, 4 minutes silent");
});

test("a nonsense fallbackMinutes falls back to the default", () => {
	for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
		const step: BotStep = { ...askStep, kind: "ask", fallbackMinutes: bad };
		const d = checkFallback({
			session: session(),
			step,
			region: uae,
			now: new Date("2026-09-14T06:04:00Z"),
		});
		assert.equal(
			d.escalate,
			false,
			`fallbackMinutes ${bad} should not fire early`,
		);
		assert.equal(d.remainingMinutes, DEFAULT_FALLBACK_MINUTES - 4);
	}
});

test("a menu waits the same way an ask does", () => {
	const menu: BotStep = {
		id: "ask-ref",
		kind: "menu",
		text: "Pick one",
		options: [{ label: "Track", keywords: ["track", "1"], next: "track" }],
	};
	const d = checkFallback({
		session: session(),
		step: menu,
		region: uae,
		now: new Date("2026-09-14T06:11:00Z"),
	});
	assert.equal(d.escalate, true);
});

test("a non-waiting step is not a fallback candidate", () => {
	const message: BotStep = {
		id: "ask-ref",
		kind: "message",
		text: "Hello",
		next: null,
	};
	const d = checkFallback({
		session: session(),
		step: message,
		region: uae,
		now: new Date("2026-09-14T09:00:00Z"),
	});
	assert.equal(d.escalate, false);
	assert.equal(d.reason, "not_waiting");
});

test("a step that no longer exists in the flow is stuck, so it escalates", () => {
	const d = checkFallback({
		session: session(),
		step: null,
		region: uae,
		now: new Date("2026-09-14T06:11:00Z"),
	});
	assert.equal(
		d.escalate,
		true,
		"a published change removed the step under them",
	);
});

test("an ended session is never escalated again", () => {
	const d = checkFallback({
		session: session({
			endedAt: "2026-09-14T06:05:00Z",
			endedReason: "handover",
			stepId: null,
		}),
		step: askStep,
		region: uae,
		now: new Date("2026-09-14T07:00:00Z"),
	});
	assert.equal(d.escalate, false);
	assert.equal(d.reason, "already_ended");
});

test("expiry beats the fallback, so a stale sweep does not dump yesterday on a desk", () => {
	const d = checkFallback({
		session: session({ updatedAt: "2026-09-13T06:00:00Z" }),
		step: askStep,
		region: uae,
		now: new Date("2026-09-14T07:00:00Z"), // 25 hours later
	});
	assert.equal(d.escalate, false);
	assert.equal(d.reason, "session_expired");
});

/* ----------------------------------------------------- the service window */

test("a closed service window is reported, because only a template will send", () => {
	const d = checkFallback({
		session: session(),
		step: askStep,
		region: uae,
		windowExpiresAt: "2026-09-14T05:00:00Z", // already past
		now: new Date("2026-09-14T06:11:00Z"),
	});
	assert.equal(d.escalate, true);
	assert.equal(d.templateOnly, true);
});

test("an open window means the agent can simply reply", () => {
	const d = checkFallback({
		session: session(),
		step: askStep,
		region: uae,
		windowExpiresAt: "2026-09-15T02:00:00Z",
		now: new Date("2026-09-14T06:11:00Z"),
	});
	assert.equal(d.templateOnly, false);
});

/* ------------------------------------------------------------------ tier 2 */

test("Tier 2 is reached only after Tier 1 has held it past the threshold", () => {
	const base = {
		session: session(),
		step: askStep,
		region: uae,
		escalatedAt: "2026-09-14T06:11:00Z",
		escalatedTier: "tier1" as const,
	};

	const soon = checkFallback({
		...base,
		now: new Date("2026-09-14T07:00:00Z"),
	});
	assert.equal(soon.escalate, false);
	assert.equal(soon.remainingMinutes, TIER2_AFTER_MINUTES - 49);

	const later = checkFallback({
		...base,
		now: new Date("2026-09-14T08:15:00Z"),
	});
	assert.equal(later.escalate, true);
	assert.equal(later.tier, "tier2");
	assert.equal(later.reason, "tier1_held_too_long");
	assert.equal(
		later.queue,
		"uae-tier2",
		"derived from the region, not invented",
	);
});

test("Tier 2 is the end of the escalation path", () => {
	const d = checkFallback({
		session: session(),
		step: askStep,
		region: uae,
		escalatedAt: "2026-09-14T06:11:00Z",
		escalatedTier: "tier2",
		now: new Date("2026-09-16T08:00:00Z"),
	});
	assert.equal(d.escalate, false, "there is no tier 3 to invent");
});

/* ------------------------------------------------------------ applying it */

test("applying a fallback ends the session as a handover, not an expiry", () => {
	const s = session();
	const d = checkFallback({
		session: s,
		step: askStep,
		region: uae,
		now: new Date("2026-09-14T06:11:00Z"),
	});
	const out = applyFallback(s, d, new Date("2026-09-14T06:11:00Z"));

	assert.equal(out.session.endedReason, "handover");
	assert.equal(
		out.session.endedReason === "handover",
		true,
		"counts as escalated, not abandoned, in crm/deflection.ts",
	);
	assert.equal(out.session.stepId, null);
	assert.equal(out.session.endedAt, "2026-09-14T06:11:00.000Z");
	assert.equal(out.effects.length, 1);
	assert.equal(out.effects[0]!.kind, "handover");
});

test("the answers already collected travel with the handover", () => {
	const s = session({ slots: { reference: "ABC-UAE-088210", weight: "40" } });
	const d = checkFallback({
		session: s,
		step: askStep,
		region: uae,
		now: new Date("2026-09-14T06:11:00Z"),
	});
	const out = applyFallback(s, d, new Date("2026-09-14T06:11:00Z"));
	const effect = out.effects[0]!;
	assert.equal(effect.kind, "handover");
	if (effect.kind !== "handover") return;
	assert.deepEqual(effect.slots, { reference: "ABC-UAE-088210", weight: "40" });
});

test("a decision not to escalate changes nothing", () => {
	const s = session();
	const d = checkFallback({
		session: s,
		step: askStep,
		region: uae,
		now: new Date("2026-09-14T06:04:00Z"),
	});
	const out = applyFallback(s, d, new Date("2026-09-14T06:04:00Z"));
	assert.equal(out.session, s, "the same object, untouched");
	assert.deepEqual(out.effects, []);
});
