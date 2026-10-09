import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MIN_REPORTABLE_RESPONSES,
	parseSurveyReply,
	shouldSendSurvey,
	summarise,
	summariseByRegion,
	surveyStillOpen,
	type CsatRecord,
	type SurveyEligibilityInput,
} from "../src/crm/csat.ts";

const now = new Date("2026-09-14T08:00:00Z");

function eligibility(
	over: Partial<SurveyEligibilityInput> = {},
): SurveyEligibilityInput {
	return {
		conversationId: "c-1",
		customerId: "cust-1",
		resolvedAt: "2026-09-14T07:50:00Z",
		alreadySurveyed: false,
		lastSurveyedCustomerAt: null,
		optedOut: false,
		windowExpiresAt: "2026-09-15T02:00:00Z",
		templateAvailable: true,
		hasPhone: true,
		...over,
	};
}

/* ------------------------------------------------------------- eligibility */

test("inside the service window the survey goes as a plain message", () => {
	const decision = shouldSendSurvey(eligibility(), now);
	assert.deepEqual(decision, { send: true, channel: "free_text" });
});

test("outside the window it needs an approved template", () => {
	const decision = shouldSendSurvey(
		eligibility({ windowExpiresAt: "2026-09-14T07:00:00Z" }),
		now,
	);
	assert.deepEqual(decision, { send: true, channel: "template" });
});

test("outside the window with no template, nothing is sent", () => {
	const decision = shouldSendSurvey(
		eligibility({ windowExpiresAt: null, templateAvailable: false }),
		now,
	);
	assert.equal(decision.send, false);
	if (decision.send) return;
	assert.equal(decision.refusal, "no_template_outside_window");
});

test("an unresolved conversation is not surveyed", () => {
	const decision = shouldSendSurvey(eligibility({ resolvedAt: null }), now);
	assert.equal(decision.send, false);
	if (decision.send) return;
	assert.equal(decision.refusal, "not_resolved");
});

test("an opted-out customer is not surveyed, service survey or not", () => {
	const decision = shouldSendSurvey(eligibility({ optedOut: true }), now);
	assert.equal(decision.send, false);
	if (decision.send) return;
	assert.equal(decision.refusal, "opted_out");
});

test("nobody is surveyed twice for the same conversation", () => {
	const decision = shouldSendSurvey(
		eligibility({ alreadySurveyed: true }),
		now,
	);
	assert.equal(decision.send, false);
	if (decision.send) return;
	assert.equal(decision.refusal, "already_surveyed");
});

test("the cooldown stops a frequent complainer being surveyed every week", () => {
	const recent = shouldSendSurvey(
		eligibility({ lastSurveyedCustomerAt: "2026-09-01T08:00:00Z" }),
		now,
	);
	assert.equal(recent.send, false);
	if (recent.send) return;
	assert.equal(recent.refusal, "cooldown");
	assert.match(recent.message, /13 days ago/);

	const longAgo = shouldSendSurvey(
		eligibility({ lastSurveyedCustomerAt: "2026-06-01T08:00:00Z" }),
		now,
	);
	assert.equal(longAgo.send, true);
});

test("a corrupt last-surveyed timestamp does not block the survey", () => {
	const decision = shouldSendSurvey(
		eligibility({ lastSurveyedCustomerAt: "not a date" }),
		now,
	);
	assert.equal(decision.send, true);
});

test("a customer with no number cannot be asked", () => {
	const decision = shouldSendSurvey(eligibility({ hasPhone: false }), now);
	assert.equal(decision.send, false);
	if (decision.send) return;
	assert.equal(decision.refusal, "no_phone");
});

/* ------------------------------------------------------------------ parsing */

test("a button payload is read exactly", () => {
	assert.deepEqual(parseSurveyReply("", "csat:4"), {
		score: 4,
		comment: null,
	});
	assert.equal(parseSurveyReply("", "csat:9"), null, "off the scale");
	assert.equal(parseSurveyReply("", "something:4"), null);
});

test("typed scores are accepted in the forms customers actually send", () => {
	assert.deepEqual(parseSurveyReply("5"), { score: 5, comment: null });
	assert.deepEqual(parseSurveyReply("5/5"), { score: 5, comment: null });
	assert.deepEqual(parseSurveyReply(" 4 "), { score: 4, comment: null });
	assert.deepEqual(parseSurveyReply("4 - good service, thanks"), {
		score: 4,
		comment: "good service, thanks",
	});
	assert.deepEqual(parseSurveyReply("1. terrible"), {
		score: 1,
		comment: "terrible",
	});
});

test("Arabic-Indic digits score, because handsets send them", () => {
	assert.deepEqual(parseSurveyReply("٥"), { score: 5, comment: null });
	assert.deepEqual(parseSurveyReply("٤"), { score: 4, comment: null });
	// Persian digits too — same keyboard families reach UAE handsets.
	assert.deepEqual(parseSurveyReply("۳"), { score: 3, comment: null });
});

test("a short reply with the score buried in it still counts", () => {
	assert.deepEqual(parseSurveyReply("it's a 5"), {
		score: 5,
		comment: "it's a 5",
	});
});

test("a reply that is not a score is not a score", () => {
	assert.equal(parseSurveyReply("thanks!"), null);
	assert.equal(parseSurveyReply(""), null);
	assert.equal(parseSurveyReply("   "), null);
	assert.equal(
		parseSurveyReply("actually I have another question about my shipment"),
		null,
		"a new question is a conversation, not a rating",
	);
	assert.equal(parseSurveyReply("6"), null, "off the scale");
	assert.equal(parseSurveyReply("0"), null);
});

test("a long message with a stray digit is not scored", () => {
	assert.equal(
		parseSurveyReply(
			"I waited 3 days for someone to call me back about this shipment",
		),
		null,
	);
});

test("a survey stops accepting answers after three days", () => {
	assert.equal(surveyStillOpen("2026-09-14T06:00:00Z", now), true);
	assert.equal(surveyStillOpen("2026-09-10T06:00:00Z", now), false);
	assert.equal(surveyStillOpen("nonsense", now), false);
});

/* ---------------------------------------------------------------- reporting */

function records(scores: number[], regionId = "uae"): CsatRecord[] {
	return scores.map((score, i) => ({
		score,
		regionId,
		agentId: "a-1",
		respondedAt: `2026-09-1${(i % 9) + 1}T08:00:00Z`,
	}));
}

test("a thin sample is not published as a score", () => {
	const summary = summarise(records([5, 5, 4]), 200);
	assert.equal(summary.responses, 3);
	assert.equal(summary.mean, 4.67, "computed, but");
	assert.equal(summary.reportable, false, "not publishable");
	assert.match(summary.note!, /too few to publish/);
	assert.equal(summary.responseRate, 3 / 200);
});

test("a sufficient sample is published with its count and rate", () => {
	const scores = [5, 5, 5, 4, 4, 4, 3, 5, 5, 4];
	const summary = summarise(records(scores), 20);
	assert.equal(summary.responses, 10);
	assert.equal(summary.reportable, true);
	assert.equal(summary.note, null);
	assert.equal(summary.mean, 4.4, "the figure the designs showed");
	assert.equal(summary.responseRate, 0.5);
	assert.deepEqual(summary.distribution, { 1: 0, 2: 0, 3: 1, 4: 4, 5: 5 });
});

test("no responses yields a gap, not a zero", () => {
	const summary = summarise([], 40);
	assert.equal(
		summary.mean,
		null,
		"not 0, which would read as total dissatisfaction",
	);
	assert.equal(summary.responses, 0);
	assert.equal(summary.responseRate, 0);
	assert.equal(summary.note, "No responses yet.");
});

test("nothing sent yields a null rate rather than a division by zero", () => {
	const summary = summarise([], 0);
	assert.equal(summary.responseRate, null);
});

test("a score outside the scale is dropped, not averaged", () => {
	const summary = summarise(
		[
			...records([5, 5]),
			{ score: 7, regionId: "uae", respondedAt: "2026-09-14T08:00:00Z" },
			{ score: 0, regionId: "uae", respondedAt: "2026-09-14T08:00:00Z" },
			{ score: 4.5, regionId: "uae", respondedAt: "2026-09-14T08:00:00Z" },
		],
		10,
	);
	assert.equal(summary.responses, 2, "the two valid ones");
	assert.equal(summary.mean, 5);
});

test("each region meets the minimum on its own", () => {
	const all = [...records(Array(12).fill(5), "uae"), ...records([5, 4], "uk")];
	const byRegion = summariseByRegion(all, { uae: 20, uk: 30 });

	assert.equal(byRegion.uae!.reportable, true);
	assert.equal(
		byRegion.uk!.reportable,
		false,
		"a healthy group sample does not license a thin regional one",
	);
	assert.equal(byRegion.uk!.responses, 2);
});

test("a region with surveys sent but none answered still appears", () => {
	const byRegion = summariseByRegion([], { ksa: 15 });
	assert.equal(byRegion.ksa!.sent, 15);
	assert.equal(byRegion.ksa!.responses, 0);
	assert.equal(byRegion.ksa!.mean, null);
});

test("the published minimum is the one the module documents", () => {
	assert.equal(MIN_REPORTABLE_RESPONSES, 10);
});
