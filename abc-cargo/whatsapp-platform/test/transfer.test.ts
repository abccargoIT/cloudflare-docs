import { test } from "node:test";
import assert from "node:assert/strict";
import type { RegionConfig } from "../src/regions.ts";
import type { Caller } from "../src/auth/policy.ts";
import {
	assertChannelUnchanged,
	canTransfer,
	transferConversation,
	type TransferableConversation,
} from "../src/crm/transfer.ts";

/** Seven days, 08:00-23:00, as confirmed by the Head of IT. */
const uae: RegionConfig = {
	id: "uae",
	label: "UAE",
	phoneNumberId: "uae-number",
	displayNumber: "+971800916",
	timezone: "Asia/Dubai",
	language: "en",
	businessHours: { days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "23:00" },
};

/** Narrower on purpose, so a closed-hours handover can be exercised. */
const uk: RegionConfig = {
	id: "uk",
	label: "UK",
	phoneNumberId: "uk-number",
	displayNumber: "+447388800000",
	timezone: "Europe/London",
	language: "en",
	businessHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
};

const regions = [uae, uk];

const lead: Caller = {
	kind: "user",
	id: "u-lead",
	email: "lead@abccargo.ae",
	displayName: "UAE Team Lead",
	role: "team_lead",
	status: "active",
	regionIds: ["uae"],
	teamIds: ["uae-support"],
};

const agent: Caller = {
	kind: "user",
	id: "u-agent",
	email: "agent@abccargo.ae",
	displayName: "UAE Agent",
	role: "agent",
	status: "active",
	regionIds: ["uae"],
	teamIds: ["uae-support"],
};

/** Monday 2026-09-14 12:00 Asia/Dubai = 08:00Z; London 09:00, both open. */
const bothOpen = new Date("2026-09-14T08:00:00Z");

function conversation(
	over: Partial<TransferableConversation> = {},
): TransferableConversation {
	return {
		id: "c-1",
		regionId: "uae",
		phoneNumberId: "uae-number",
		assignedAgentId: "u-agent",
		assignedTeamId: "uae-support",
		windowExpiresAt: new Date(bothOpen.getTime() + 20 * 3600_000).toISOString(),
		firstResponseDueAt: new Date(
			bothOpen.getTime() + 25 * 60_000,
		).toISOString(),
		firstRespondedAt: null,
		...over,
	};
}

/* ------------------------------------------------- the number does not move */

test("a cross-region transfer leaves the WhatsApp number alone", () => {
	const result = transferConversation(
		lead,
		conversation(),
		{
			toTeamId: "uk-support",
			toRegionId: "uk",
			reason: "Customer is in London and asked for a UK contact",
		},
		regions,
		bothOpen,
	);
	assert.equal(result.ok, true);
	if (!result.ok) return;

	assert.equal(result.patch.regionId, "uk", "ownership moved");
	assert.equal(
		result.patch.phoneNumberId,
		"uae-number",
		"the customer's thread is still on the number they wrote to",
	);
	assert.notEqual(result.patch.phoneNumberId, uk.phoneNumberId);
});

test("assertChannelUnchanged refuses a write that would split the thread", () => {
	const before = conversation();
	assert.doesNotThrow(() => assertChannelUnchanged(before, "uae-number"));
	assert.throws(
		() => assertChannelUnchanged(before, "uk-number"),
		/must not change the WhatsApp number/,
	);
});

/* ---------------------------------------------------- the clock is preserved */

test("the first-response target is carried over, not restarted", () => {
	const convo = conversation();
	const result = transferConversation(
		lead,
		convo,
		{ toTeamId: "uk-support", toRegionId: "uk", reason: "Overnight cover" },
		regions,
		bothOpen,
	);
	assert.ok(result.ok);
	if (!result.ok) return;
	assert.equal(result.patch.firstResponseDueAt, convo.firstResponseDueAt);
});

test("transferring a late conversation says so instead of clearing it", () => {
	const late = conversation({
		firstResponseDueAt: new Date(bothOpen.getTime() - 60_000).toISOString(),
	});
	const result = transferConversation(
		lead,
		late,
		{ toTeamId: "uk-support", toRegionId: "uk", reason: "Escalating" },
		regions,
		bothOpen,
	);
	assert.ok(result.ok);
	if (!result.ok) return;
	assert.equal(result.patch.firstResponseDueAt, late.firstResponseDueAt);
	assert.ok(
		result.warnings.some((w) => w.code === "first_response_already_late"),
	);
});

test("an answered conversation raises no first-response warning", () => {
	const answered = conversation({
		firstResponseDueAt: new Date(bothOpen.getTime() - 60_000).toISOString(),
		firstRespondedAt: new Date(bothOpen.getTime() - 120_000).toISOString(),
	});
	const result = transferConversation(
		lead,
		answered,
		{ toTeamId: "uk-support", toRegionId: "uk", reason: "Follow-up in UK" },
		regions,
		bothOpen,
	);
	assert.ok(result.ok);
	if (!result.ok) return;
	assert.ok(
		!result.warnings.some((w) => w.code === "first_response_already_late"),
	);
});

/* --------------------------------------------------------------- warnings */

test("handing work to a closed region warns rather than silently queueing it", () => {
	// Sunday 2026-09-13 12:00 Asia/Dubai = 08:00Z. UAE open 7 days; UK shut.
	const sunday = new Date("2026-09-13T08:00:00Z");
	const result = transferConversation(
		lead,
		conversation({
			windowExpiresAt: new Date(sunday.getTime() + 20 * 3600_000).toISOString(),
			firstResponseDueAt: new Date(
				sunday.getTime() + 25 * 60_000,
			).toISOString(),
		}),
		{ toTeamId: "uk-support", toRegionId: "uk", reason: "UK customer" },
		regions,
		sunday,
	);
	assert.ok(result.ok);
	if (!result.ok) return;
	const codes = result.warnings.map((w) => w.code);
	assert.ok(codes.includes("receiving_region_closed"));
	assert.ok(codes.includes("first_response_due_outside_receiving_hours"));
});

test("a closed service window is called out, because only a template will send", () => {
	const result = transferConversation(
		lead,
		conversation({ windowExpiresAt: null }),
		{ toTeamId: "uk-support", toRegionId: "uk", reason: "Reassigning" },
		regions,
		bothOpen,
	);
	assert.ok(result.ok);
	if (!result.ok) return;
	assert.ok(result.warnings.some((w) => w.code === "service_window_closed"));
});

test("a window about to close is flagged with the minutes left", () => {
	const result = transferConversation(
		lead,
		conversation({
			windowExpiresAt: new Date(bothOpen.getTime() + 25 * 60_000).toISOString(),
		}),
		{ toTeamId: "uk-support", toRegionId: "uk", reason: "Reassigning" },
		regions,
		bothOpen,
	);
	assert.ok(result.ok);
	if (!result.ok) return;
	const warning = result.warnings.find(
		(w) => w.code === "service_window_closing_soon",
	);
	assert.ok(warning);
	assert.match(warning!.message, /25 minutes/);
});

test("a routine same-region handover in open hours warns about nothing", () => {
	const result = transferConversation(
		lead,
		conversation(),
		{
			toTeamId: "uae-sales",
			toRegionId: "uae",
			reason: "This is a quotation, not a claim",
		},
		regions,
		bothOpen,
	);
	assert.ok(result.ok);
	if (!result.ok) return;
	assert.deepEqual(result.warnings, []);
	assert.equal(result.record.crossRegion, false);
});

/* ---------------------------------------------------------- authorisation */

test("an agent may hand their own work to a colleague in their region", () => {
	assert.equal(canTransfer(agent, conversation(), "uae").allowed, true);
});

test("an agent may not push work to another country", () => {
	const decision = canTransfer(agent, conversation(), "uk");
	assert.equal(decision.allowed, false);
	assert.equal(decision.refusal, "insufficient_role");
});

test("an agent may not move somebody else's conversation", () => {
	const decision = canTransfer(
		agent,
		conversation({ assignedAgentId: "someone-else" }),
		"uae",
	);
	assert.equal(decision.allowed, false);
});

test("a lead cannot transfer out of a region they do not cover", () => {
	const decision = canTransfer(lead, conversation({ regionId: "ksa" }), "uae");
	assert.equal(decision.allowed, false);
	assert.equal(decision.refusal, "wrong_region");
});

test("transferring out does not require access to the destination", () => {
	// The UAE lead has no UK region in scope, and that is fine: giving work
	// away is not reading the other region's records.
	assert.deepEqual(lead.regionIds, ["uae"]);
	assert.equal(canTransfer(lead, conversation(), "uk").allowed, true);
});

test("a suspended account cannot transfer", () => {
	const suspended: Caller = { ...lead, status: "suspended" };
	assert.equal(
		canTransfer(suspended, conversation(), "uae").refusal,
		"suspended",
	);
});

test("a service caller cannot transfer: no judgement, no name for the record", () => {
	const service: Caller = { kind: "service", name: "milestone-poster" };
	assert.equal(
		canTransfer(service, conversation(), "uae").refusal,
		"service_caller",
	);
});

/* -------------------------------------------------------------- refusals */

test("a transfer without a reason is refused", () => {
	const result = transferConversation(
		lead,
		conversation(),
		{ toTeamId: "uk-support", toRegionId: "uk", reason: "   " },
		regions,
		bothOpen,
	);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.refusal, "reason_required");
});

test("an unknown destination region is refused", () => {
	const result = transferConversation(
		lead,
		conversation(),
		{ toTeamId: "om-support", toRegionId: "oman", reason: "Oman handles this" },
		regions,
		bothOpen,
	);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.refusal, "unknown_region");
});

test("transferring to where it already sits is refused, not recorded", () => {
	const result = transferConversation(
		lead,
		conversation(),
		{
			toTeamId: "uae-support",
			toRegionId: "uae",
			toAgentId: "u-agent",
			reason: "No change",
		},
		regions,
		bothOpen,
	);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.refusal, "same_team");
});

/* ----------------------------------------------------------------- record */

test("the record names who, from where, to where and why", () => {
	const result = transferConversation(
		lead,
		conversation(),
		{
			toTeamId: "uk-support",
			toRegionId: "uk",
			reason: "Customer relocated to Manchester",
		},
		regions,
		bothOpen,
	);
	assert.ok(result.ok);
	if (!result.ok) return;
	assert.deepEqual(result.record, {
		conversationId: "c-1",
		fromRegionId: "uae",
		toRegionId: "uk",
		fromTeamId: "uae-support",
		toTeamId: "uk-support",
		fromAgentId: "u-agent",
		toAgentId: null,
		actor: "u-lead",
		reason: "Customer relocated to Manchester",
		at: bothOpen.toISOString(),
		crossRegion: true,
	});
});

test("without a named recipient the work goes to the receiving team's queue", () => {
	const result = transferConversation(
		lead,
		conversation(),
		{ toTeamId: "uk-support", toRegionId: "uk", reason: "Overnight" },
		regions,
		bothOpen,
	);
	assert.ok(result.ok);
	if (!result.ok) return;
	assert.equal(
		result.patch.assignedAgentId,
		null,
		"not left with the previous owner, who is now in the wrong region",
	);
});
