import { test } from "node:test";
import assert from "node:assert/strict";
import {
	abandonmentHotspots,
	classifySession,
	MIN_REPORTABLE_SESSIONS,
	summariseByFlow,
	summariseDeflection,
	type SessionOutcomeInput,
} from "../src/crm/deflection.ts";

function session(over: Partial<SessionOutcomeInput> = {}): SessionOutcomeInput {
	return {
		endedReason: "completed",
		humanReplied: false,
		ended: true,
		...over,
	};
}

/* ------------------------------------------------------- classification */

test("a finished flow with no human is deflected", () => {
	assert.equal(classifySession(session()), "deflected");
});

test("a finished flow a human also answered is not deflected", () => {
	assert.equal(
		classifySession(session({ humanReplied: true })),
		"escalated",
		"the end reason describes the flow, not the conversation",
	);
});

test("every handover reason is an escalation", () => {
	for (const reason of ["handover", "customer_asked_for_agent"] as const) {
		assert.equal(
			classifySession(session({ endedReason: reason })),
			"escalated",
		);
	}
});

test("a bot failure is an escalation, never a deflection", () => {
	for (const reason of ["too_many_invalid_replies", "flow_stuck"] as const) {
		assert.equal(
			classifySession(session({ endedReason: reason })),
			"escalated",
			`${reason} is the bot failing`,
		);
	}
});

test("a customer who went quiet is abandoned, which is its own answer", () => {
	assert.equal(
		classifySession(session({ endedReason: "expired" })),
		"abandoned",
	);
});

test("an expiry a human had already handled is an escalation", () => {
	assert.equal(
		classifySession(session({ endedReason: "expired", humanReplied: true })),
		"escalated",
	);
});

test("a running session counts nowhere", () => {
	assert.equal(classifySession(session({ ended: false })), "in_progress");
	assert.equal(classifySession(session({ endedReason: null })), "in_progress");
});

/* ------------------------------------------------------------ the rates */

test("abandonment is in the denominator, so the rate cannot be inflated", () => {
	const sessions = [
		...Array(40)
			.fill(null)
			.map(() => session()),
		...Array(40)
			.fill(null)
			.map(() => session({ endedReason: "handover" })),
		...Array(20)
			.fill(null)
			.map(() => session({ endedReason: "expired" })),
	];
	const summary = summariseDeflection(sessions);

	assert.equal(summary.deflected, 40);
	assert.equal(summary.escalated, 40);
	assert.equal(summary.abandoned, 20);
	assert.equal(summary.resolved, 100);

	assert.equal(summary.deflectionRate, 0.4, "the figure for the dashboard");
	assert.equal(
		summary.rateExcludingAbandoned,
		0.5,
		"the flattering figure, named so it cannot be quoted bare",
	);
	assert.equal(summary.abandonmentRate, 0.2);
});

test("the two rates agree only when nothing was abandoned", () => {
	const sessions = [
		...Array(30)
			.fill(null)
			.map(() => session()),
		...Array(20)
			.fill(null)
			.map(() => session({ endedReason: "handover" })),
	];
	const summary = summariseDeflection(sessions);
	assert.equal(summary.deflectionRate, 0.6);
	assert.equal(summary.rateExcludingAbandoned, 0.6);
	assert.equal(summary.abandonmentRate, 0);
});

test("in-progress sessions are excluded from the denominator", () => {
	const sessions = [
		...Array(25)
			.fill(null)
			.map(() => session()),
		...Array(100)
			.fill(null)
			.map(() => session({ ended: false })),
	];
	const summary = summariseDeflection(sessions);
	assert.equal(summary.inProgress, 100);
	assert.equal(summary.resolved, 25);
	assert.equal(summary.deflectionRate, 1);
});

test("a thin sample is not published as a rate", () => {
	const summary = summariseDeflection([session(), session()]);
	assert.equal(summary.deflectionRate, 1, "computed");
	assert.equal(summary.reportable, false, "not publishable");
	assert.match(summary.note!, /too few to publish/);
});

test("nothing ended yields nulls rather than zeros", () => {
	const summary = summariseDeflection([]);
	assert.equal(summary.deflectionRate, null);
	assert.equal(summary.rateExcludingAbandoned, null);
	assert.equal(summary.abandonmentRate, null);
	assert.equal(summary.note, "No completed bot sessions yet.");
});

test("all abandoned gives a zero rate and a null excluding-abandoned rate", () => {
	const sessions = Array(25)
		.fill(null)
		.map(() => session({ endedReason: "expired" }));
	const summary = summariseDeflection(sessions);
	assert.equal(summary.deflectionRate, 0);
	assert.equal(
		summary.rateExcludingAbandoned,
		null,
		"no decided sessions to divide by",
	);
	assert.equal(summary.abandonmentRate, 1);
});

test("the designed 41% is reachable from real counts", () => {
	// 41 deflected, 39 escalated, 20 abandoned.
	const sessions = [
		...Array(41)
			.fill(null)
			.map(() => session()),
		...Array(39)
			.fill(null)
			.map(() => session({ endedReason: "handover" })),
		...Array(20)
			.fill(null)
			.map(() => session({ endedReason: "expired" })),
	];
	assert.equal(summariseDeflection(sessions).deflectionRate, 0.41);
});

/* ------------------------------------------------------------- per flow */

test("the per-flow breakdown finds the flow that is failing", () => {
	const sessions = [
		...Array(25)
			.fill(null)
			.map(() => ({ ...session(), flowId: "tracking" })),
		...Array(25)
			.fill(null)
			.map(() => ({
				...session({ endedReason: "flow_stuck" }),
				flowId: "claims",
			})),
	];
	const byFlow = summariseByFlow(sessions);
	assert.equal(byFlow.tracking!.deflectionRate, 1);
	assert.equal(byFlow.claims!.deflectionRate, 0);
	assert.equal(byFlow.claims!.escalated, 25);
});

test("each flow is held to the minimum on its own", () => {
	const sessions = [
		...Array(25)
			.fill(null)
			.map(() => ({ ...session(), flowId: "tracking" })),
		{ ...session(), flowId: "rare" },
	];
	const byFlow = summariseByFlow(sessions);
	assert.equal(byFlow.tracking!.reportable, true);
	assert.equal(byFlow.rare!.reportable, false);
});

/* -------------------------------------------------------- hotspots */

test("abandonment is interpretable per step even when it is not in aggregate", () => {
	const sessions = [
		...Array(7)
			.fill(null)
			.map(() => ({
				...session({ endedReason: "expired" }),
				lastStepId: "ask-weight",
			})),
		...Array(2)
			.fill(null)
			.map(() => ({
				...session({ endedReason: "expired" }),
				lastStepId: "ask-destination",
			})),
		// Not abandoned, so not a hotspot however it ended.
		{ ...session(), lastStepId: "ask-weight" },
		{ ...session({ endedReason: "handover" }), lastStepId: "ask-weight" },
	];
	assert.deepEqual(abandonmentHotspots(sessions), [
		{ stepId: "ask-weight", count: 7 },
		{ stepId: "ask-destination", count: 2 },
	]);
});

test("sessions with no recorded step are skipped rather than grouped as empty", () => {
	const sessions = [
		{ ...session({ endedReason: "expired" }), lastStepId: null },
		{ ...session({ endedReason: "expired" }), lastStepId: "ask-weight" },
	];
	assert.deepEqual(abandonmentHotspots(sessions), [
		{ stepId: "ask-weight", count: 1 },
	]);
});

test("the published minimum is the one the module documents", () => {
	assert.equal(MIN_REPORTABLE_SESSIONS, 20);
});
