import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CUSTOMER_STAGE_LABELS,
	deriveCustomerStage,
	leadTemperature,
	lifecycleFor,
	temperatureBand,
	type CustomerFacts,
} from "../src/crm/customer-lifecycle.ts";

const NOW = new Date("2026-10-08T12:00:00Z");
const daysAgo = (days: number) =>
	new Date(NOW.getTime() - days * 86_400_000).toISOString();

function facts(overrides: Partial<CustomerFacts> = {}): CustomerFacts {
	return { leads: [], quotations: [], bookings: [], ...overrides };
}

/* ------------------------------------------------------------------ stages */

test("somebody we know nothing about is a prospect", () => {
	assert.equal(deriveCustomerStage(facts(), NOW), "prospect");
});

test("an open enquiry nobody has touched is a plain lead", () => {
	assert.equal(
		deriveCustomerStage(
			facts({ leads: [{ stage: "new", updatedAt: daysAgo(90) }] }),
			NOW,
		),
		"lead",
	);
});

test("an enquiry being worked is engaged — observed, not declared", () => {
	// The design's "Hot Lead" is a badge somebody has to remember to set. Each
	// of these reaches the same place without anyone remembering anything.
	const recent = facts({ leads: [{ stage: "new", updatedAt: daysAgo(3) }] });
	assert.equal(deriveCustomerStage(recent, NOW), "engaged");

	const quoted = facts({
		leads: [{ stage: "quoted", updatedAt: daysAgo(90) }],
	});
	assert.equal(deriveCustomerStage(quoted, NOW), "engaged");

	const outstanding = facts({
		leads: [{ stage: "new", updatedAt: daysAgo(90) }],
		quotations: [{ status: "sent", updatedAt: daysAgo(90) }],
	});
	assert.equal(deriveCustomerStage(outstanding, NOW), "engaged");
});

test("won on paper but nothing shipped is its own state", () => {
	// The list somebody should be chasing. Neither "lead" nor "customer"
	// describes it, and conflating it with either hides the chase.
	assert.equal(
		deriveCustomerStage(
			facts({ quotations: [{ status: "accepted", updatedAt: daysAgo(2) }] }),
			NOW,
		),
		"committed",
	);
	assert.equal(
		deriveCustomerStage(
			facts({ leads: [{ stage: "won", updatedAt: daysAgo(2) }] }),
			NOW,
		),
		"committed",
	);
});

test("one shipment makes a customer, more than one a repeat customer", () => {
	assert.equal(
		deriveCustomerStage(
			facts({ bookings: [{ milestone: "delivered", createdAt: daysAgo(10) }] }),
			NOW,
		),
		"customer",
	);
	assert.equal(
		deriveCustomerStage(
			facts({
				bookings: [
					{ milestone: "delivered", createdAt: daysAgo(200) },
					{ milestone: "in_transit", createdAt: daysAgo(10) },
				],
			}),
			NOW,
		),
		"repeat_customer",
	);
});

test("shipping beats everything else that is open", () => {
	// A trade account with a brand new enquiry is still a customer. One field
	// cannot say both, which is exactly why the pipeline is kept separately.
	const stage = deriveCustomerStage(
		facts({
			bookings: [{ milestone: "delivered", createdAt: daysAgo(30) }],
			leads: [{ stage: "new", updatedAt: daysAgo(1) }],
		}),
		NOW,
	);
	assert.equal(stage, "customer");
});

test("a customer gone quiet reads as dormant", () => {
	assert.equal(
		deriveCustomerStage(
			facts({
				bookings: [{ milestone: "delivered", createdAt: daysAgo(400) }],
				lastInboundAt: daysAgo(400),
			}),
			NOW,
		),
		"dormant",
	);
});

test("an open enquiry keeps a quiet customer out of dormancy", () => {
	// They are talking to us about something. Filing them as dormant would
	// drop them out of the very lists meant to catch them. The point of this
	// test is the absence of "dormant", not which customer stage replaces it.
	assert.equal(
		deriveCustomerStage(
			facts({
				bookings: [{ milestone: "delivered", createdAt: daysAgo(400) }],
				leads: [{ stage: "qualified", updatedAt: daysAgo(2) }],
				lastInboundAt: daysAgo(2),
			}),
			NOW,
		),
		"customer",
	);
	// And with two old shipments it is still not dormant, just repeat.
	assert.equal(
		deriveCustomerStage(
			facts({
				bookings: [
					{ milestone: "delivered", createdAt: daysAgo(500) },
					{ milestone: "delivered", createdAt: daysAgo(400) },
				],
				leads: [{ stage: "qualified", updatedAt: daysAgo(2) }],
				lastInboundAt: daysAgo(2),
			}),
			NOW,
		),
		"repeat_customer",
	);
});

test("enquiries that all came to nothing are lapsed, not prospect", () => {
	// The difference matters: never asked is not the same as asked and lost.
	assert.equal(
		deriveCustomerStage(
			facts({ leads: [{ stage: "lost", updatedAt: daysAgo(40) }] }),
			NOW,
		),
		"lapsed",
	);
});

test("unparseable or missing dates do not throw or flatter", () => {
	const stage = deriveCustomerStage(
		facts({
			bookings: [{ milestone: "booked", createdAt: "not-a-date" }],
			lastInboundAt: null,
		}),
		NOW,
	);
	// No usable date means no evidence of recent life, so: dormant.
	assert.equal(stage, "dormant");
});

test("every stage has a label fit for a screen", () => {
	for (const [stage, label] of Object.entries(CUSTOMER_STAGE_LABELS)) {
		assert.ok(label.length > 0, stage);
		assert.ok(label[0] === label[0]?.toUpperCase(), `${stage} not capitalised`);
	}
});

/* ------------------------------------------------------------- temperature */

test("no open enquiry is no temperature at all", () => {
	assert.equal(leadTemperature(facts(), NOW), 0);
	assert.equal(
		leadTemperature(
			facts({ bookings: [{ milestone: "delivered", createdAt: daysAgo(5) }] }),
			NOW,
		),
		0,
	);
});

test("a negotiation touched today outranks an untouched old enquiry", () => {
	const hot = leadTemperature(
		facts({
			leads: [{ stage: "negotiating", updatedAt: daysAgo(1) }],
			quotations: [{ status: "sent", updatedAt: daysAgo(1) }],
		}),
		NOW,
	);
	const cold = leadTemperature(
		facts({ leads: [{ stage: "new", updatedAt: daysAgo(120) }] }),
		NOW,
	);
	assert.ok(hot > cold, `${hot} should beat ${cold}`);
	assert.equal(temperatureBand(hot), "hot");
	assert.equal(temperatureBand(cold), "cold");
});

test("the score stays inside its bounds at both extremes", () => {
	const everything = leadTemperature(
		facts({
			leads: [
				{ stage: "qualified", updatedAt: daysAgo(0) },
				{ stage: "quoted", updatedAt: daysAgo(0) },
				{ stage: "negotiating", updatedAt: daysAgo(0) },
			],
			quotations: [
				{ status: "sent", updatedAt: daysAgo(0) },
				{ status: "negotiating", updatedAt: daysAgo(0) },
			],
			bookings: [{ milestone: "delivered", createdAt: daysAgo(10) }],
			lastInboundAt: daysAgo(0),
		}),
		NOW,
	);
	assert.ok(everything <= 100, String(everything));
	assert.equal(everything, 100);

	const stale = leadTemperature(
		facts({ leads: [{ stage: "new", updatedAt: daysAgo(900) }] }),
		NOW,
	);
	assert.ok(stale >= 0, String(stale));
});

test("the combined view gives a screen everything it needs at once", () => {
	const view = lifecycleFor(
		facts({
			leads: [{ stage: "negotiating", updatedAt: daysAgo(1) }],
			quotations: [{ status: "sent", updatedAt: daysAgo(1) }],
		}),
		NOW,
	);
	assert.equal(view.stage, "engaged");
	assert.equal(view.label, "Active lead");
	assert.equal(view.band, "hot");
	assert.ok(view.temperature > 70);
});
