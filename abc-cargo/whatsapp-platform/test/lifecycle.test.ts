import { test } from "node:test";
import assert from "node:assert/strict";
import {
	assertLeadTransition,
	assertMilestoneAdvance,
	assertQuotationTransition,
	canAdvanceLead,
	canAdvanceMilestone,
	canMoveQuotation,
	checkStall,
	InvalidTransitionError,
	isLeadOpen,
	leadStageForQuotation,
	shouldNotifyCustomer,
	templateForMilestone,
} from "../src/crm/lifecycle.ts";
import { LEAD_STAGES, MILESTONES } from "../src/crm/types.ts";

test("a lead follows the stages in order", () => {
	assert.ok(canAdvanceLead("new", "qualified"));
	assert.ok(canAdvanceLead("qualified", "quoted"));
	assert.ok(canAdvanceLead("quoted", "negotiating"));
	assert.ok(canAdvanceLead("negotiating", "won"));
});

test("a lead cannot skip qualification", () => {
	assert.equal(canAdvanceLead("new", "quoted"), false);
	assert.throws(
		() => assertLeadTransition("new", "quoted"),
		InvalidTransitionError,
	);
});

test("a lead cannot move backwards", () => {
	assert.equal(canAdvanceLead("quoted", "new"), false);
	assert.equal(canAdvanceLead("won", "negotiating"), false);
});

test("a lead can be lost from any open stage", () => {
	for (const stage of LEAD_STAGES) {
		if (stage === "won" || stage === "lost") continue;
		assert.ok(canAdvanceLead(stage, "lost"), `${stage} should be losable`);
	}
});

test("won and lost are terminal", () => {
	assert.equal(isLeadOpen("won"), false);
	assert.equal(isLeadOpen("lost"), false);
	assert.equal(isLeadOpen("new"), true);
	for (const stage of LEAD_STAGES) {
		assert.equal(canAdvanceLead("won", stage), false);
		assert.equal(canAdvanceLead("lost", stage), false);
	}
});

test("a quotation moves through its own states", () => {
	assert.ok(canMoveQuotation("draft", "sent"));
	assert.ok(canMoveQuotation("sent", "accepted"));
	assert.equal(canMoveQuotation("accepted", "lost"), false);
	assert.throws(
		() => assertQuotationTransition("accepted", "sent"),
		InvalidTransitionError,
	);
});

test("an expired quotation can be re-sent", () => {
	assert.ok(canMoveQuotation("expired", "sent"));
});

test("a quotation status implies the lead stage", () => {
	assert.equal(leadStageForQuotation("sent"), "quoted");
	assert.equal(leadStageForQuotation("negotiating"), "negotiating");
	assert.equal(leadStageForQuotation("accepted"), "won");
	assert.equal(leadStageForQuotation("lost"), "lost");
	assert.equal(leadStageForQuotation("draft"), null);
});

test("milestones only move forward", () => {
	assert.ok(canAdvanceMilestone("booked", "collected"));
	assert.ok(canAdvanceMilestone("booked", "delivered"));
	assert.equal(canAdvanceMilestone("arrived", "departed"), false);
	assert.equal(canAdvanceMilestone("delivered", "delivered"), false);
	assert.throws(
		() => assertMilestoneAdvance("cleared", "in_transit"),
		InvalidTransitionError,
	);
});

test("every milestone can reach delivered except delivered itself", () => {
	for (const m of MILESTONES) {
		if (m === "delivered") continue;
		assert.ok(canAdvanceMilestone(m, "delivered"));
	}
});

test("a shipment past its threshold is stalled", () => {
	const now = new Date("2026-09-15T12:00:00Z");
	// "collected" stalls after 24 hours; this one has sat for 30.
	const check = checkStall("collected", "2026-09-14T06:00:00Z", now);
	assert.equal(check.stalled, true);
	assert.equal(check.thresholdHours, 24);
	assert.equal(check.hoursSinceMilestone, 30);
});

test("a shipment inside its threshold is not stalled", () => {
	const now = new Date("2026-09-15T12:00:00Z");
	// "departed" allows 72 hours; this one is 30 hours in.
	assert.equal(
		checkStall("departed", "2026-09-14T06:00:00Z", now).stalled,
		false,
	);
});

test("a delivered shipment never stalls", () => {
	const now = new Date("2027-01-01T00:00:00Z");
	const check = checkStall("delivered", "2026-01-01T00:00:00Z", now);
	assert.equal(check.stalled, false);
	assert.equal(check.thresholdHours, Number.POSITIVE_INFINITY);
});

test("an unparseable milestone timestamp is rejected", () => {
	assert.throws(() => checkStall("booked", "not-a-date"), /ISO 8601/);
});

test("only customer-facing milestones send a message", () => {
	assert.equal(shouldNotifyCustomer("delivered"), true);
	assert.equal(shouldNotifyCustomer("in_transit"), false);
	assert.equal(templateForMilestone("in_transit"), null);
	assert.equal(templateForMilestone("delivered"), "abc_delivery_completed");
	assert.equal(templateForMilestone("arrived"), "abc_shipment_status_update");
});
