import { test } from "node:test";
import assert from "node:assert/strict";
import {
	canApproveBroadcast,
	canComposeBroadcast,
	canResolveAudience,
	canSendBroadcast,
	canStopBroadcast,
	canTransition,
	checkReadyToSend,
	resolutionIsFresh,
	RESOLUTION_FRESHNESS_HOURS,
	voidsApproval,
	type BroadcastRef,
} from "../src/broadcasts/policy.ts";
import { advances } from "../src/broadcasts/types.ts";
import type { Caller } from "../src/auth/policy.ts";

const NOW = new Date("2026-10-08T12:00:00.000Z");

function person(overrides: Partial<Caller> = {}): Caller {
	return {
		kind: "user",
		id: "usr_lead",
		email: "lead@abccargo.ae",
		displayName: "Lead",
		role: "team_lead",
		status: "active",
		regionIds: ["uae"],
		teamIds: ["team_uae"],
		...overrides,
	} as Caller;
}

const service: Caller = { kind: "service", name: "importer" };

function broadcast(overrides: Partial<BroadcastRef> = {}): BroadcastRef {
	return {
		id: "bc_1",
		regionId: "uae",
		status: "review",
		createdBy: "usr_author",
		resolvedAt: "2026-10-08T11:00:00.000Z",
		resolvedCount: 4812,
		approvedBy: null,
		approvedAt: null,
		startedAt: null,
		...overrides,
	};
}

/* ----------------------------------------------------------------- composing */

test("an agent cannot compose a broadcast", () => {
	// An agent answers the customers in front of them. Choosing what five
	// thousand of them are told is a different job with different
	// accountability.
	const agent = person({ role: "agent" });
	const decision = canComposeBroadcast(agent, "uae");
	assert.equal(decision.allowed, false);
	assert.equal(
		decision.allowed === false && decision.reason,
		"insufficient_role",
	);
});

test("a machine credential cannot compose a campaign", () => {
	// Everything else in the platform lets a service principal through. A key
	// in a config file that could message every customer would be an odd thing
	// to leave lying about.
	const decision = canComposeBroadcast(service, "uae");
	assert.equal(decision.allowed, false);
	assert.equal(decision.allowed === false && decision.reason, "service_caller");
});

test("a lead composes only in their own regions", () => {
	assert.equal(canComposeBroadcast(person(), "uae").allowed, true);
	const wrong = canComposeBroadcast(person(), "ksa");
	assert.equal(wrong.allowed === false && wrong.reason, "wrong_region");
	// A master admin covers all three.
	assert.equal(
		canComposeBroadcast(person({ role: "master_admin", regionIds: [] }), "ksa")
			.allowed,
		true,
	);
});

/* ----------------------------------------------------------------- approval */

test("nobody approves their own broadcast", () => {
	// The failure this catches — wrong template, wrong audience, a placeholder
	// left in the text — is caught by nothing else in the platform, and is
	// caught almost every time by one other person reading it.
	const mine = broadcast({ createdBy: "usr_lead" });
	const decision = canApproveBroadcast(person(), mine);
	assert.equal(decision.allowed, false);
	assert.equal(decision.allowed === false && decision.reason, "own_broadcast");
	assert.match(
		decision.allowed === false ? decision.message : "",
		/ask a colleague/,
	);
});

test("a colleague may approve it", () => {
	assert.equal(canApproveBroadcast(person(), broadcast()).allowed, true);
});

test("an unresolved broadcast cannot be approved", () => {
	// There is no list to approve. Approval has to attach to particular people.
	const decision = canApproveBroadcast(
		person(),
		broadcast({ resolvedAt: null, resolvedCount: null }),
	);
	assert.equal(decision.allowed === false && decision.reason, "not_resolved");
});

test("an audience of nobody cannot be approved", () => {
	// Almost always a filter mistake or the marketing opt-in excluding
	// everyone, and approving it would hide that.
	const decision = canApproveBroadcast(
		person(),
		broadcast({ resolvedCount: 0 }),
	);
	assert.equal(
		decision.allowed === false && decision.reason,
		"nothing_to_send",
	);
	assert.match(decision.allowed === false ? decision.message : "", /opt-in/);
});

test("approval happens from review, not from draft", () => {
	const decision = canApproveBroadcast(
		person(),
		broadcast({ status: "draft" }),
	);
	assert.equal(decision.allowed === false && decision.reason, "not_in_review");
});

/* -------------------------------------------------------------- the switch */

test("sending is refused outright when the deployment is not switched on", () => {
	// A platform that can message every customer the moment it is deployed is
	// one bad merge away from doing so.
	const ready = broadcast({
		status: "approved",
		approvedBy: "usr_other",
		approvedAt: NOW.toISOString(),
	});
	const off = canSendBroadcast({
		caller: person(),
		broadcast: ready,
		sendingEnabled: false,
	});
	assert.equal(off.allowed === false && off.reason, "sending_disabled");

	const on = canSendBroadcast({
		caller: person(),
		broadcast: ready,
		sendingEnabled: true,
	});
	assert.equal(on.allowed, true);
});

test("an unapproved broadcast cannot be sent even with the switch on", () => {
	const decision = canSendBroadcast({
		caller: person(),
		broadcast: broadcast({ status: "approved", approvedBy: null }),
		sendingEnabled: true,
	});
	assert.equal(decision.allowed === false && decision.reason, "not_approved");
});

test("a finished broadcast cannot be sent again", () => {
	for (const status of ["sent", "cancelled"] as const) {
		const decision = canSendBroadcast({
			caller: person(),
			broadcast: broadcast({ status, approvedBy: "usr_other" }),
			sendingEnabled: true,
		});
		assert.equal(
			decision.allowed === false && decision.reason,
			"already_finished",
		);
	}
});

/* -------------------------------------------------------------- staleness */

test("a stale list must be resolved again before a first send", () => {
	const stale = broadcast({
		status: "approved",
		approvedBy: "usr_other",
		resolvedAt: new Date(
			NOW.getTime() - (RESOLUTION_FRESHNESS_HOURS + 1) * 3_600_000,
		).toISOString(),
	});
	const decision = checkReadyToSend({
		caller: person(),
		broadcast: stale,
		sendingEnabled: true,
		now: NOW,
	});
	assert.equal(
		decision.allowed === false && decision.reason,
		"stale_resolution",
	);
});

test("resuming a paused campaign is not blocked by staleness", () => {
	// Blocking it would strand a half-sent campaign: the rest could only be
	// reached by rebuilding it and excluding the already-messaged by hand.
	// Opt-outs since the list was drawn up are caught per recipient at send
	// time instead.
	const resuming = broadcast({
		status: "paused",
		approvedBy: "usr_other",
		startedAt: "2026-10-01T09:00:00.000Z",
		resolvedAt: "2026-09-30T09:00:00.000Z",
	});
	const decision = checkReadyToSend({
		caller: person(),
		broadcast: resuming,
		sendingEnabled: true,
		now: NOW,
	});
	assert.equal(decision.allowed, true);
});

test("freshness is measured, and an unreadable date is not fresh", () => {
	assert.equal(resolutionIsFresh("2026-10-08T11:00:00.000Z", NOW), true);
	assert.equal(resolutionIsFresh("2026-10-01T11:00:00.000Z", NOW), false);
	assert.equal(resolutionIsFresh(null, NOW), false);
	assert.equal(resolutionIsFresh("nonsense", NOW), false);
});

/* -------------------------------------------------------------- re-aiming */

test("a campaign that has started cannot be re-aimed", () => {
	// Reconciling a new list against the people already messaged either
	// messages somebody twice or drops them silently.
	const started = broadcast({
		status: "paused",
		startedAt: "2026-10-08T10:00:00.000Z",
	});
	const decision = canResolveAudience(person(), started);
	assert.equal(
		decision.allowed === false && decision.reason,
		"already_finished",
	);
	assert.equal(canResolveAudience(person(), broadcast()).allowed, true);
});

test("changing the message or the audience voids an approval", () => {
	// Otherwise the thing a second person read is not the thing that goes out.
	assert.equal(voidsApproval(["audience"]), true);
	assert.equal(voidsApproval(["templateName"]), true);
	assert.equal(voidsApproval(["components"]), true);
	assert.equal(voidsApproval(["kind"]), true);
	assert.equal(voidsApproval(["languageCode"]), true);
	// Renaming the campaign or slowing it down does not.
	assert.equal(voidsApproval(["name"]), false);
	assert.equal(voidsApproval(["ratePerMinute"]), false);
	assert.equal(voidsApproval(["name", "audience"]), true);
});

/* ------------------------------------------------------------ transitions */

test("the lifecycle only runs the way it is meant to", () => {
	assert.equal(canTransition("draft", "review").allowed, true);
	assert.equal(canTransition("review", "approved").allowed, true);
	assert.equal(canTransition("approved", "sending").allowed, true);
	assert.equal(canTransition("sending", "paused").allowed, true);
	assert.equal(canTransition("paused", "sending").allowed, true);
	assert.equal(canTransition("sending", "sent").allowed, true);

	// Nothing skips approval, and nothing comes back from the end.
	assert.equal(canTransition("draft", "sending").allowed, false);
	assert.equal(canTransition("review", "sending").allowed, false);
	assert.equal(canTransition("sent", "sending").allowed, false);
	assert.equal(canTransition("cancelled", "draft").allowed, false);
	assert.equal(canTransition("sent", "draft").allowed, false);
});

test("anything unfinished can be stopped", () => {
	for (const status of [
		"draft",
		"review",
		"approved",
		"sending",
		"paused",
	] as const) {
		assert.equal(
			canStopBroadcast(person(), broadcast({ status })).allowed,
			true,
			status,
		);
	}
	assert.equal(
		canStopBroadcast(person(), broadcast({ status: "sent" })).allowed,
		false,
	);
});

/* -------------------------------------------------------- delivery states */

test("a delivery state only ever moves forwards", () => {
	// WhatsApp does not promise the order these arrive in. A late "delivered"
	// after a "read" must not make a campaign's read figure fall.
	assert.equal(advances("sent", "delivered"), true);
	assert.equal(advances("delivered", "read"), true);
	assert.equal(advances("read", "replied"), true);
	assert.equal(advances("read", "delivered"), false);
	assert.equal(advances("replied", "read"), false);
	assert.equal(advances("sent", "sent"), false);
	// A skipped or failed recipient is not something a status webhook revives.
	assert.equal(advances("skipped", "delivered"), false);
	assert.equal(advances("failed", "delivered"), false);
	assert.equal(advances("pending", "delivered"), false);
});
