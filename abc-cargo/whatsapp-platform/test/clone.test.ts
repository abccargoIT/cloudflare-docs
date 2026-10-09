import { test } from "node:test";
import assert from "node:assert/strict";
import type { RegionConfig } from "../src/regions.ts";
import type { BotFlow } from "../src/bots/types.ts";
import { cloneFlowToRegion, cloneNeedsReview } from "../src/bots/clone.ts";

const uae: RegionConfig = {
	id: "uae",
	label: "UAE",
	phoneNumberId: "uae-number",
	displayNumber: "+971800916",
	timezone: "Asia/Dubai",
	language: "en",
	businessHours: { days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "23:00" },
};

const ksa: RegionConfig = {
	id: "ksa",
	label: "KSA",
	phoneNumberId: "ksa-number",
	displayNumber: "+966548454866",
	timezone: "Asia/Riyadh",
	language: "ar",
	businessHours: { days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "23:00" },
};

function flow(over: Partial<BotFlow> = {}): BotFlow {
	return {
		id: "tracking",
		regionId: "uae",
		name: "Tracking",
		version: 7,
		status: "published",
		entryStepId: "ask-ref",
		steps: [
			{
				id: "ask-ref",
				kind: "ask",
				text: "Which reference should I look up?",
				slot: "reference",
				next: "handover",
			},
			{
				id: "handover",
				kind: "handover",
				text: "Putting you through to the team.",
				queue: "uae-support",
			},
		],
		...over,
	};
}

/* ------------------------------------------------------- the queue remap */

test("a queue naming the source region is remapped, and the remap is reported", () => {
	const out = cloneFlowToRegion(flow(), uae, ksa);
	assert.equal(out.ok, true);
	if (!out.ok) return;

	const handover = out.flow.steps.find((s) => s.id === "handover")!;
	assert.equal(handover.kind, "handover");
	if (handover.kind !== "handover") return;
	assert.equal(
		handover.queue,
		"ksa-support",
		"a Saudi customer must not land in the Dubai queue",
	);

	const warning = out.warnings.find((w) => w.code === "queue_remapped");
	assert.ok(warning);
	assert.match(warning!.message, /check that desk exists in KSA/);
});

test("a queue that names no region is left alone and flagged loudly", () => {
	const out = cloneFlowToRegion(
		flow({
			steps: [
				{
					id: "handover",
					kind: "handover",
					queue: "claims-specialists",
				},
			],
			entryStepId: "handover",
		}),
		uae,
		ksa,
	);
	assert.ok(out.ok);
	if (!out.ok) return;

	const handover = out.flow.steps[0]!;
	assert.equal(handover.kind, "handover");
	if (handover.kind !== "handover") return;
	assert.equal(handover.queue, "claims-specialists", "not guessed at");

	const warning = out.warnings.find((w) => w.code === "queue_unrecognised");
	assert.ok(warning);
	assert.match(warning!.message, /route KSA customers to wherever/);
});

test("a handover with no queue needs no remap", () => {
	const out = cloneFlowToRegion(
		flow({
			steps: [{ id: "handover", kind: "handover" }],
			entryStepId: "handover",
		}),
		uae,
		ksa,
	);
	assert.ok(out.ok);
	if (!out.ok) return;
	assert.equal(
		out.warnings.filter((w) => w.code.startsWith("queue")).length,
		0,
	);
});

/* ------------------------------------------------------- the clone itself */

test("a clone is always a draft at version 1", () => {
	const out = cloneFlowToRegion(flow(), uae, ksa);
	assert.ok(out.ok);
	if (!out.ok) return;
	assert.equal(out.flow.status, "draft", "never straight onto a live number");
	assert.equal(out.flow.version, 1, "shares no history with the original");
	assert.equal(out.flow.regionId, "ksa");
	assert.equal(out.flow.id, "tracking-ksa");
	assert.equal(out.flow.name, "Tracking (KSA)");
});

test("the id and name can be given explicitly", () => {
	const out = cloneFlowToRegion(flow(), uae, ksa, {
		newId: "ksa-tracking-v1",
		name: "KSA tracking",
	});
	assert.ok(out.ok);
	if (!out.ok) return;
	assert.equal(out.flow.id, "ksa-tracking-v1");
	assert.equal(out.flow.name, "KSA tracking");
});

test("the original is not mutated", () => {
	const original = flow();
	const before = JSON.stringify(original);
	cloneFlowToRegion(original, uae, ksa);
	assert.equal(JSON.stringify(original), before);
});

test("the clone is run through the ordinary publish checks", () => {
	const out = cloneFlowToRegion(flow(), uae, ksa);
	assert.ok(out.ok);
	if (!out.ok) return;
	assert.equal(typeof out.validation.ok, "boolean");
	assert.equal(out.validation.ok, true, "a sound flow clones to a sound flow");
});

/* ------------------------------------------------ what cannot be fixed */

test("a step quoting the source number is reported, not rewritten", () => {
	const out = cloneFlowToRegion(
		flow({
			steps: [
				{
					id: "ask-ref",
					kind: "message",
					text: "Call us on +971 800 916 if it is urgent.",
					next: null,
				},
			],
		}),
		uae,
		ksa,
	);
	assert.ok(out.ok);
	if (!out.ok) return;
	const w = out.warnings.find((x) => x.code === "mentions_source_number");
	assert.ok(w, JSON.stringify(out.warnings));
	// The text is untouched: silently editing a customer-facing message is
	// worse than asking a person to read it.
	const step = out.flow.steps[0]!;
	assert.match((step as { text: string }).text, /\+971 800 916/);
});

test("a currency, a time of day and a region name are each reported", () => {
	const out = cloneFlowToRegion(
		flow({
			steps: [
				{
					id: "ask-ref",
					kind: "ask",
					text: "Our Dubai desk is open 08:00 to 23:00. Rates start at AED 45.",
					slot: "x",
					next: "ask-ref",
				},
			],
		}),
		uae,
		ksa,
	);
	assert.ok(out.ok);
	if (!out.ok) return;
	const codes = out.warnings.map((w) => w.code);
	assert.ok(codes.includes("mentions_currency"), codes.join(","));
	assert.ok(codes.includes("mentions_hours"), codes.join(","));
	assert.ok(codes.includes("mentions_region_name"), codes.join(","));
});

test("the city from the timezone counts as the region's name", () => {
	const out = cloneFlowToRegion(
		flow({
			steps: [
				{
					id: "ask-ref",
					kind: "message",
					text: "Dubai team here.",
					next: null,
				},
			],
		}),
		uae,
		ksa,
	);
	assert.ok(out.ok);
	if (!out.ok) return;
	assert.ok(out.warnings.some((w) => w.code === "mentions_region_name"));
});

test("menu option labels are inspected too", () => {
	const out = cloneFlowToRegion(
		flow({
			steps: [
				{
					id: "ask-ref",
					kind: "menu",
					text: "Pick one",
					options: [
						{ label: "Quote in AED", keywords: ["1"], next: "ask-ref" },
					],
				},
			],
		}),
		uae,
		ksa,
	);
	assert.ok(out.ok);
	if (!out.ok) return;
	assert.ok(out.warnings.some((w) => w.code === "mentions_currency"));
});

test("a differing language is reported once, for the flow", () => {
	const out = cloneFlowToRegion(flow(), uae, ksa);
	assert.ok(out.ok);
	if (!out.ok) return;
	const w = out.warnings.filter((x) => x.code === "language_differs");
	assert.equal(w.length, 1);
	assert.equal(w[0]!.stepId, null);
	assert.match(w[0]!.message, /not translated by cloning/);
});

test("same-language regions raise no language warning", () => {
	const uk: RegionConfig = { ...ksa, id: "uk", label: "UK", language: "en" };
	const out = cloneFlowToRegion(flow(), uae, uk);
	assert.ok(out.ok);
	if (!out.ok) return;
	assert.ok(!out.warnings.some((w) => w.code === "language_differs"));
});

test("each warning code is reported at most once per step", () => {
	const out = cloneFlowToRegion(
		flow({
			steps: [
				{
					id: "ask-ref",
					kind: "ask",
					text: "AED 45 or AED 90?",
					retryText: "Please say AED 45 or AED 90.",
					slot: "x",
					next: "ask-ref",
				},
			],
		}),
		uae,
		ksa,
	);
	assert.ok(out.ok);
	if (!out.ok) return;
	assert.equal(
		out.warnings.filter(
			(w) => w.code === "mentions_currency" && w.stepId === "ask-ref",
		).length,
		1,
		"four mentions on one step is still one thing to fix",
	);
});

/* ------------------------------------------------------------- refusals */

test("a flow filed under another region is refused", () => {
	const out = cloneFlowToRegion(flow({ regionId: "ksa" }), uae, ksa);
	assert.equal(out.ok, false);
	if (out.ok) return;
	assert.match(out.error, /belongs to region ksa/);
});

test("cloning onto the same region is refused", () => {
	const out = cloneFlowToRegion(flow(), uae, uae);
	assert.equal(out.ok, false);
	if (out.ok) return;
	assert.match(out.error, /its own region/);
});

test("an empty flow is refused", () => {
	const out = cloneFlowToRegion(flow({ steps: [] }), uae, ksa);
	assert.equal(out.ok, false);
});

/* ---------------------------------------------------------- needs review */

test("a clone with any warning needs a human", () => {
	const out = cloneFlowToRegion(flow(), uae, ksa);
	assert.ok(out.ok);
	if (!out.ok) return;
	assert.equal(cloneNeedsReview(out), true);
});

test("a clone with nothing flagged does not", () => {
	const plain = flow({
		steps: [
			{
				id: "ask-ref",
				kind: "ask",
				text: "Which reference should I look up?",
				slot: "reference",
				next: "end",
			},
			{ id: "end", kind: "end", text: "Thank you." },
		],
	});
	const uk: RegionConfig = { ...ksa, id: "uk", label: "UK", language: "en" };
	const out = cloneFlowToRegion(plain, uae, uk);
	assert.ok(out.ok);
	if (!out.ok) return;
	assert.deepEqual(out.warnings, [], JSON.stringify(out.warnings));
	assert.equal(cloneNeedsReview(out), false);
});

test("a queue that is exactly the region id is remapped, not left behind", () => {
	// The starter flow uses a bare `uae` rather than `uae-support`, and the
	// first version of remapQueue only matched the hyphenated form — so the
	// clearest case of all was reported as unrecognised and carried over.
	const out = cloneFlowToRegion(
		flow({
			steps: [{ id: "handover", kind: "handover", queue: "uae" }],
			entryStepId: "handover",
		}),
		uae,
		ksa,
	);
	assert.ok(out.ok);
	if (!out.ok) return;

	const handover = out.flow.steps[0]!;
	assert.equal(handover.kind, "handover");
	if (handover.kind !== "handover") return;
	assert.equal(handover.queue, "ksa");
	assert.ok(out.warnings.some((w) => w.code === "queue_remapped"));
	assert.ok(!out.warnings.some((w) => w.code === "queue_unrecognised"));
});
