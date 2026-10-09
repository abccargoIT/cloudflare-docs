import { test } from "node:test";
import assert from "node:assert/strict";
import type { RegionConfig } from "../src/regions.ts";
import type { BotFlow, BotSession } from "../src/bots/types.ts";
import { DEFAULT_FALLBACK_MINUTES } from "../src/bots/escalation.ts";
import { planFallback } from "../src/bots/fallback-sweep.ts";
import { heldByPerson } from "../src/bots/runner.ts";

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

const flow: BotFlow = {
	id: "f1",
	regionId: "uae",
	name: "Test",
	version: 1,
	status: "published",
	entryStepId: "ask-ref",
	steps: [
		{
			id: "ask-ref",
			kind: "ask",
			text: "Which reference?",
			slot: "reference",
			next: "done",
		},
		{ id: "done", kind: "end", text: "Thanks." },
	],
};

/** Waiting since Monday 2026-09-14 10:00 Dubai (06:00Z). */
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

const minutesAfter = (iso: string, minutes: number) =>
	new Date(Date.parse(iso) + minutes * 60_000);

/* ----------------------------------------------------------- planFallback */

test("a session inside its threshold is left alone", () => {
	const action = planFallback({
		session: session(),
		flow,
		region: uae,
		windowExpiresAt: "2026-09-15T06:00:00Z",
		now: minutesAfter("2026-09-14T06:00:00Z", DEFAULT_FALLBACK_MINUTES - 1),
	});
	assert.equal(action.kind, "none");
});

test("silent past the threshold is handed over, ended, with the reason traced", () => {
	const now = minutesAfter(
		"2026-09-14T06:00:00Z",
		DEFAULT_FALLBACK_MINUTES + 1,
	);
	const action = planFallback({
		session: session(),
		flow,
		region: uae,
		windowExpiresAt: "2026-09-15T06:00:00Z",
		now,
	});
	assert.equal(action.kind, "handover");
	assert.equal(action.ended.endedReason, "handover");
	assert.equal(action.ended.stepId, null);
	assert.equal(action.ended.endedAt, now.toISOString());
	// The answers already given are kept for the agent.
	assert.equal(action.ended.slots["reference"], "ABC-UAE-088210");
	assert.equal(action.trace[0]?.kind, "timeout");
	assert.match(action.trace[0]?.note ?? "", /business minutes/);
});

test("silence overnight does not count: no handover at 08:05 after a 22:55 question", () => {
	// Monday 22:55 Dubai (18:55Z) to Tuesday 08:04 Dubai (04:04Z): 9 business minutes.
	const action = planFallback({
		session: session({ updatedAt: "2026-09-14T18:55:00Z" }),
		flow,
		region: uae,
		windowExpiresAt: "2026-09-15T18:55:00Z",
		now: new Date("2026-09-15T04:04:00Z"),
	});
	assert.equal(action.kind, "none");
});

test("a handover with the window closed says a template is needed", () => {
	const action = planFallback({
		session: session(),
		flow,
		region: uae,
		windowExpiresAt: "2026-09-14T05:00:00Z",
		now: minutesAfter("2026-09-14T06:00:00Z", 30),
	});
	assert.equal(action.kind, "handover");
	assert.match(action.trace[0]?.note ?? "", /template/);
});

test("past the session lifetime the session expires instead of escalating", () => {
	const action = planFallback({
		session: session(),
		flow,
		region: uae,
		windowExpiresAt: null,
		now: new Date("2026-09-15T07:00:00Z"),
	});
	assert.equal(action.kind, "expire");
	assert.equal(action.ended.endedReason, "expired");
	assert.equal(action.ended.stepId, null);
});

test("a session waiting on a step the flow no longer has is treated as stuck", () => {
	const action = planFallback({
		session: session({ stepId: "gone" }),
		flow,
		region: uae,
		windowExpiresAt: "2026-09-15T06:00:00Z",
		now: minutesAfter("2026-09-14T06:00:00Z", 30),
	});
	assert.equal(action.kind, "handover");
});

test("an ended session is never touched", () => {
	const action = planFallback({
		session: session({
			stepId: null,
			endedAt: "2026-09-14T06:05:00Z",
			endedReason: "completed",
		}),
		flow,
		region: uae,
		windowExpiresAt: null,
		now: new Date("2026-09-16T06:00:00Z"),
	});
	assert.equal(action.kind, "none");
});

/* ----------------------------------------------------------- heldByPerson */

const handedOver = session({
	stepId: null,
	endedAt: "2026-09-14T06:10:00Z",
	endedReason: "handover",
});

test("after a handover the next message is the agent's, not the bot's", () => {
	assert.equal(
		heldByPerson(handedOver, "open", new Date("2026-09-14T07:00:00Z")),
		true,
	);
	for (const reason of [
		"customer_asked_for_agent",
		"too_many_invalid_replies",
		"flow_stuck",
	] as const) {
		assert.equal(
			heldByPerson(
				{ ...handedOver, endedReason: reason },
				"pending",
				new Date("2026-09-14T07:00:00Z"),
			),
			true,
			reason,
		);
	}
});

test("a resolved conversation goes back to the bot", () => {
	assert.equal(
		heldByPerson(handedOver, "resolved", new Date("2026-09-14T07:00:00Z")),
		false,
	);
});

test("a completed or expired session does not hold the conversation", () => {
	for (const reason of ["completed", "expired"] as const) {
		assert.equal(
			heldByPerson(
				{ ...handedOver, endedReason: reason },
				"open",
				new Date("2026-09-14T07:00:00Z"),
			),
			false,
			reason,
		);
	}
});

test("a day after the handover the customer is greeted again", () => {
	assert.equal(
		heldByPerson(handedOver, "open", new Date("2026-09-15T06:10:00Z")),
		false,
	);
});

test("no session, a live session, or an unknown status means not held", () => {
	const now = new Date("2026-09-14T07:00:00Z");
	assert.equal(heldByPerson(null, "open", now), false);
	assert.equal(heldByPerson(session(), "open", now), false);
	assert.equal(heldByPerson(handedOver, null, now), false);
});
