import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_INVALID_REPLIES,
	MAX_STEPS_PER_TURN,
	render,
	resumableSession,
	runTurn,
	SESSION_TTL_HOURS,
} from "../src/bots/runtime.ts";
import { previewFlow } from "../src/bots/preview.ts";
import { buildStarterFlow } from "../src/bots/templates.ts";
import type { BotFlow, BotSession, BotStep } from "../src/bots/types.ts";

const NOW = new Date("2026-10-08T09:00:00.000Z");

function flow(steps: BotStep[], entryStepId = steps[0]?.id ?? "a"): BotFlow {
	return {
		id: "flow_test",
		regionId: "uae",
		name: "test",
		version: 1,
		status: "published",
		entryStepId,
		steps,
	};
}

const starter = (() => {
	const built = buildStarterFlow({ id: "uae", label: "UAE" });
	return flow(built.steps, built.entryStepId);
})();

const texts = (result: ReturnType<typeof runTurn>) =>
	result.effects.filter((e) => e.kind === "send_text").map((e) => e.text);

/* ------------------------------------------------------------ the escape */

test("asking for a person works before the flow has even started", () => {
	const result = runTurn({
		flow: starter,
		session: null,
		text: "I need to speak to someone please",
		now: NOW,
	});
	assert.equal(result.session.endedReason, "customer_asked_for_agent");
	assert.ok(result.effects.some((e) => e.kind === "handover"));
});

test("asking for a person works while a question is waiting", () => {
	// The rule that matters most on a number that takes damage claims: it does
	// not depend on the flow's author having thought of it.
	const opened = runTurn({
		flow: starter,
		session: null,
		text: "I want a quotation",
		now: NOW,
	});
	assert.ok(opened.session.stepId, "the flow should be waiting for an answer");

	const escaped = runTurn({
		flow: starter,
		session: opened.session,
		text: "just put me through to a human",
		now: NOW,
	});
	assert.equal(escaped.session.endedReason, "customer_asked_for_agent");
});

test("a menu option wins over the escape hatch", () => {
	// If the author put "agent" on an option, that option is what they meant.
	const f = flow([
		{
			id: "m",
			kind: "menu",
			text: "pick",
			options: [
				{ label: "Speak to sales", keywords: ["agent"], next: "sales" },
				{ label: "Something else", keywords: ["other"], next: "other" },
			],
		},
		{ id: "sales", kind: "message", text: "sales it is", next: null },
		{ id: "other", kind: "end" },
	]);
	const opened = runTurn({ flow: f, session: null, text: "hello", now: NOW });
	const chosen = runTurn({
		flow: f,
		session: opened.session,
		text: "agent",
		now: NOW,
	});
	assert.deepEqual(texts(chosen), ["sales it is"]);
	assert.equal(chosen.session.endedReason, "completed");
});

/* --------------------------------------------------------- giving up well */

test("a menu gives up rather than repeating itself forever", () => {
	// The third identical menu is where a customer stops replying and starts
	// telephoning, and nobody finds out why.
	const f = flow([
		{
			id: "m",
			kind: "menu",
			text: "pick one",
			options: [{ label: "Track", keywords: ["track"], next: "e" }],
		},
		{ id: "e", kind: "end" },
	]);
	let session: BotSession | null = runTurn({
		flow: f,
		session: null,
		text: "hello",
		now: NOW,
	}).session;

	for (let i = 1; i <= MAX_INVALID_REPLIES; i++) {
		const result = runTurn({ flow: f, session, text: "?????", now: NOW });
		session = result.session;
		assert.equal(
			result.session.endedReason,
			null,
			`retry ${i} should still be open`,
		);
		assert.equal(result.session.invalidReplies, i);
	}

	const final = runTurn({ flow: f, session, text: "?????", now: NOW });
	assert.equal(final.session.endedReason, "too_many_invalid_replies");
	assert.ok(final.effects.some((e) => e.kind === "handover"));
});

test("a good answer clears the count, so a typo is not held against anyone", () => {
	const f = flow([
		{
			id: "q",
			kind: "ask",
			text: "reference?",
			slot: "reference",
			expect: "reference",
			next: "e",
		},
		{ id: "e", kind: "end" },
	]);
	const opened = runTurn({ flow: f, session: null, text: "hi", now: NOW });
	const fumbled = runTurn({
		flow: f,
		session: opened.session,
		text: "erm",
		now: NOW,
	});
	assert.equal(fumbled.session.invalidReplies, 1);
	const good = runTurn({
		flow: f,
		session: fumbled.session,
		text: "ABC-UAE-088210",
		now: NOW,
	});
	assert.equal(good.session.invalidReplies, 0);
	assert.equal(good.session.slots["reference"], "ABCUAE088210");
});

test("the handover carries the answers already given", () => {
	// So the agent opens the conversation knowing them instead of asking again,
	// which is the main thing customers hold against a bot handover.
	const result = previewFlow({
		flow: starter,
		messages: [
			{ text: "how much to send a box to London" },
			{ text: "Dubai to London" },
			{ text: "two boxes, about 12 kg" },
		],
	});
	const handover = result.turns
		.flatMap((t) => t.effects)
		.find((e) => e.kind === "handover");
	assert.ok(handover, "the quotation path should reach an agent");
	assert.equal(handover.slots["route"], "Dubai to London");
	assert.equal(handover.slots["goods"], "two boxes, about 12 kg");
});

/* ------------------------------------------------------------- the budget */

test("a flow that runs round without waiting is stopped and handed over", () => {
	// validateFlow refuses to publish this. A flow written straight into the
	// database can still do it, and silence would be the worst answer.
	const f = flow([
		{ id: "a", kind: "message", text: "one", next: "b" },
		{ id: "b", kind: "message", text: "two", next: "a" },
	]);
	const result = runTurn({ flow: f, session: null, text: "hello", now: NOW });
	assert.equal(result.session.endedReason, "flow_stuck");
	assert.ok(result.trace.some((t) => t.kind === "budget"));
	assert.ok(texts(result).length <= MAX_STEPS_PER_TURN + 1);
});

test("a step that points at nothing ends in a person, not an exception", () => {
	const f = flow([{ id: "a", kind: "message", text: "hello", next: "gone" }]);
	const result = runTurn({ flow: f, session: null, text: "hi", now: NOW });
	assert.equal(result.session.endedReason, "flow_stuck");
	assert.ok(result.effects.some((e) => e.kind === "handover"));
});

/* ------------------------------------------------------------- versioning */

test("publishing a new version does not move a customer mid-answer", () => {
	// The step they are waiting on may not exist in the new version. Worse, it
	// may exist and mean something else.
	const session: BotSession = {
		flowId: "flow_test",
		flowVersion: 1,
		stepId: "ask_reference",
		slots: { reference: "ABCUAE088210" },
		invalidReplies: 0,
		turns: 1,
		startedAt: NOW.toISOString(),
		updatedAt: NOW.toISOString(),
		endedAt: null,
		endedReason: null,
	};
	assert.equal(
		resumableSession(session, starter, NOW)?.stepId,
		"ask_reference",
	);
	assert.equal(
		resumableSession(session, { ...starter, version: 2 }, NOW),
		null,
	);
});

test("a session older than the service window is not resumed", () => {
	const session: BotSession = {
		flowId: "flow_test",
		flowVersion: 1,
		stepId: "ask_reference",
		slots: {},
		invalidReplies: 0,
		turns: 1,
		startedAt: NOW.toISOString(),
		updatedAt: NOW.toISOString(),
		endedAt: null,
		endedReason: null,
	};
	const justInside = new Date(
		NOW.getTime() + (SESSION_TTL_HOURS - 1) * 3_600_000,
	);
	const justOutside = new Date(
		NOW.getTime() + (SESSION_TTL_HOURS + 1) * 3_600_000,
	);
	assert.ok(resumableSession(session, starter, justInside));
	assert.equal(resumableSession(session, starter, justOutside), null);
	// An unreadable timestamp starts again rather than resuming on a guess.
	assert.equal(
		resumableSession({ ...session, updatedAt: "nonsense" }, starter, NOW),
		null,
	);
});

test("a message after the session ended starts the flow again", () => {
	const ended = runTurn({
		flow: starter,
		session: null,
		text: "speak to a person",
		now: NOW,
	});
	assert.ok(ended.session.endedAt);
	const again = runTurn({
		flow: starter,
		session: ended.session,
		text: "hello",
		now: NOW,
	});
	assert.equal(again.session.endedAt, null);
	assert.equal(again.session.turns, 1);
});

/* ----------------------------------------------------------------- lookup */

test("a reference in the first message is used instead of being asked for", () => {
	const result = runTurn({
		flow: starter,
		session: null,
		text: "where is my shipment ABC-UAE-088210",
		facts: {
			references: ["ABCUAE088210"],
			booking: { ref: "ABC-UAE-088210", milestone: "Departed Dubai" },
		},
		now: NOW,
	});
	const said = texts(result).join("\n");
	assert.match(said, /ABC-UAE-088210/);
	assert.match(said, /Departed Dubai/);
	assert.ok(!said.includes("Could you send the shipment reference"));
});

test("a reference we hold no record of reaches a person", () => {
	// This is also what an unreachable shipment system looks like, and a person
	// is the right answer to both.
	const result = runTurn({
		flow: starter,
		session: null,
		text: "where is ABC-UAE-999999",
		facts: { references: ["ABCUAE999999"], booking: null },
		now: NOW,
	});
	// It asks for the reference once, since the message had no match.
	assert.match(texts(result).join("\n"), /shipment reference/);
	const answered = runTurn({
		flow: starter,
		session: result.session,
		text: "ABC-UAE-999999",
		facts: { booking: null },
		now: NOW,
	});
	assert.equal(answered.session.endedReason, "handover");
	assert.match(texts(answered).join("\n"), /cannot find ABCUAE999999/);
});

/* -------------------------------------------------------------- creation */

test("a claim opens a claim ticket and goes to a person", () => {
	const result = previewFlow({
		flow: starter,
		messages: [
			{ text: "my shipment arrived damaged" },
			{ text: "the box was crushed and one item is broken" },
		],
	});
	const effects = result.turns.flatMap((t) => t.effects);
	const ticket = effects.find((e) => e.kind === "open_ticket");
	assert.ok(ticket);
	assert.equal(ticket.type, "claim");
	assert.equal(result.handedOver, true);
});

test("a rate enquiry opens a lead", () => {
	const result = previewFlow({
		flow: starter,
		messages: [
			{ text: "what is the price to send 20kg to Riyadh" },
			{ text: "Dubai to Riyadh" },
			{ text: "clothes, 20 kg" },
		],
	});
	assert.ok(
		result.turns.flatMap((t) => t.effects).some((e) => e.kind === "open_lead"),
	);
});

/* ------------------------------------------------------------- rendering */

test("an unknown placeholder renders as nothing, not as itself", () => {
	// "Hello," is an awkward sentence. "Hello {{name}}," is a customer reading
	// our source code.
	assert.equal(
		render("Hello {{contact.name}}, welcome.", {}, {}),
		"Hello, welcome.",
	);
	assert.equal(
		render("Hello {{contact.name}}.", {}, { contactName: "Mariam" }),
		"Hello Mariam.",
	);
	assert.equal(
		render(
			"Shipment {{booking.ref}} is {{booking.milestone}}.",
			{},
			{
				booking: { ref: "ABC-UAE-1", milestone: "In transit" },
			},
		),
		"Shipment ABC-UAE-1 is In transit.",
	);
	assert.equal(
		render("Your {{slot}} is noted.", { slot: "box" }, {}),
		"Your box is noted.",
	);
});

/* --------------------------------------------------------------- answers */

test("an answer is checked for shape before it is kept", () => {
	const f = flow([
		{
			id: "q",
			kind: "ask",
			text: "email?",
			slot: "email",
			expect: "email",
			next: "e",
		},
		{ id: "e", kind: "end" },
	]);
	const opened = runTurn({ flow: f, session: null, text: "hi", now: NOW });
	const wrong = runTurn({
		flow: f,
		session: opened.session,
		text: "not an address",
		now: NOW,
	});
	assert.equal(wrong.session.slots["email"], undefined);
	const right = runTurn({
		flow: f,
		session: opened.session,
		text: "Mariam@ABCCargo.AE",
		now: NOW,
	});
	assert.equal(right.session.slots["email"], "mariam@abccargo.ae");
});

test("a menu is answered by its number or by a word", () => {
	const f = flow([
		{
			id: "m",
			kind: "menu",
			text: "pick",
			options: [
				{ label: "Track a shipment", keywords: ["track"], next: "one" },
				{ label: "Get a quote", keywords: ["quote"], next: "two" },
			],
		},
		{ id: "one", kind: "message", text: "tracking", next: null },
		{ id: "two", kind: "message", text: "quoting", next: null },
	]);
	const opened = runTurn({ flow: f, session: null, text: "hello", now: NOW });
	assert.match(texts(opened).join("\n"), /1\. Track a shipment/);

	for (const [reply, expected] of [
		["2", "quoting"],
		["quote", "quoting"],
		["I would like a quote for a pallet", "quoting"],
		["1", "tracking"],
	] as const) {
		const result = runTurn({
			flow: f,
			session: opened.session,
			text: reply,
			now: NOW,
		});
		assert.deepEqual(texts(result), [expected], reply);
	}
});

/* --------------------------------------------------------------- preview */

test("the preview reports what would be sent without sending it", () => {
	const result = previewFlow({
		flow: starter,
		messages: [{ text: "hello" }, { text: "1" }],
	});
	assert.equal(result.validation.ok, true);
	assert.equal(result.turns.length, 2);
	assert.match(result.turns[0]?.replies.join("\n") ?? "", /How can we help/);
	// Every turn carries the runtime's own account of why it did what it did.
	assert.ok(result.turns.every((t) => t.trace.length > 0));
});
