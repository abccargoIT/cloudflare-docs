import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFlow, MAX_TEXT_LENGTH } from "../src/bots/validate.ts";
import { parseSteps } from "../src/bots/parse.ts";
import { buildStarterFlow } from "../src/bots/templates.ts";
import type { BotFlow, BotStep } from "../src/bots/types.ts";

function flow(steps: BotStep[], entryStepId = steps[0]?.id ?? "a"): BotFlow {
	return {
		id: "flow_test",
		regionId: "uae",
		name: "test",
		version: 1,
		status: "draft",
		entryStepId,
		steps,
	};
}

const codes = (f: BotFlow) => validateFlow(f).problems.map((p) => p.code);

/* --------------------------------------------------------------- the basics */

test("the starter flow is publishable as written", () => {
	// If the one flow shipped with the platform does not pass its own
	// validator, the validator is the thing that gets switched off.
	const starter = buildStarterFlow({ id: "uae", label: "UAE" });
	const result = validateFlow(flow(starter.steps, starter.entryStepId));
	assert.equal(
		result.ok,
		true,
		JSON.stringify(
			result.problems.filter((p) => p.severity === "error"),
			null,
			1,
		),
	);
});

test("a step pointing at nothing is refused", () => {
	// The runtime survives this — it hands over — but the customer gets a
	// handover instead of an answer and nobody knows why.
	const result = validateFlow(
		flow([{ id: "a", kind: "message", text: "hello", next: "nowhere" }]),
	);
	assert.equal(result.ok, false);
	assert.ok(result.problems.some((p) => p.code === "dangling_next"));
});

test("two steps with the same id are refused", () => {
	const result = validateFlow(
		flow([
			{ id: "a", kind: "message", text: "one", next: null },
			{ id: "a", kind: "message", text: "two", next: null },
		]),
	);
	assert.equal(result.ok, false);
	assert.ok(result.problems.some((p) => p.code === "duplicate_step_id"));
});

test("a flow that starts nowhere is refused", () => {
	const result = validateFlow(
		flow([{ id: "a", kind: "end" }], "somewhere_else"),
	);
	assert.equal(result.ok, false);
	assert.ok(result.problems.some((p) => p.code === "unknown_entry_step"));
});

test("a step with nothing to say is refused", () => {
	assert.ok(
		codes(
			flow([{ id: "a", kind: "message", text: "   ", next: null }]),
		).includes("empty_text"),
	);
});

test("a message longer than WhatsApp accepts is refused", () => {
	// It would be accepted here and rejected by the Cloud API, which is a
	// failure with no customer-visible cause.
	const result = validateFlow(
		flow([
			{
				id: "a",
				kind: "message",
				text: "x".repeat(MAX_TEXT_LENGTH + 1),
				next: null,
			},
		]),
	);
	assert.equal(result.ok, false);
	assert.ok(result.problems.some((p) => p.code === "text_too_long"));
});

/* ----------------------------------------------------------------- menus */

test("two menu options answering to the same word are refused", () => {
	// The customer types it and reaches whichever option is listed first,
	// which is not a decision anybody made.
	const result = validateFlow(
		flow([
			{
				id: "m",
				kind: "menu",
				text: "pick",
				options: [
					{ label: "Track", keywords: ["status"], next: "e" },
					{ label: "Claim", keywords: ["Status"], next: "e" },
				],
			},
			{ id: "e", kind: "end" },
		]),
	);
	assert.equal(result.ok, false);
	const problem = result.problems.find(
		(p) => p.code === "duplicate_menu_keyword",
	);
	assert.ok(problem);
	assert.match(problem.message, /options 1 and 2/);
});

test("a menu with no options is refused", () => {
	assert.ok(
		codes(
			flow([{ id: "m", kind: "menu", text: "pick", options: [] }]),
		).includes("empty_menu"),
	);
});

/* ------------------------------------------------------------------ loops */

test("a cycle that never waits for the customer is refused", () => {
	const result = validateFlow(
		flow([
			{ id: "a", kind: "message", text: "one", next: "b" },
			{ id: "b", kind: "message", text: "two", next: "a" },
		]),
	);
	assert.equal(result.ok, false);
	const problem = result.problems.find((p) => p.code === "tight_loop");
	assert.ok(problem);
	assert.match(problem.message, /a → b/);
});

test("a loop through a question is an ordinary repeat, not a fault", () => {
	// This is the shape of every menu that returns to itself. Refusing it
	// would refuse most real flows.
	const result = validateFlow(
		flow([
			{ id: "a", kind: "message", text: "hello", next: "q" },
			{
				id: "q",
				kind: "ask",
				text: "again?",
				slot: "again",
				next: "a",
			},
		]),
	);
	assert.equal(
		result.problems.filter((p) => p.code === "tight_loop").length,
		0,
		JSON.stringify(result.problems),
	);
});

test("a loop through a menu is not a fault either", () => {
	const result = validateFlow(
		flow([
			{
				id: "m",
				kind: "menu",
				text: "pick",
				options: [{ label: "Again", keywords: ["again"], next: "m" }],
			},
		]),
	);
	assert.equal(
		result.problems.filter((p) => p.code === "tight_loop").length,
		0,
	);
});

test("a self-pointing run-through step is caught", () => {
	const result = validateFlow(
		flow([{ id: "a", kind: "message", text: "hello", next: "a" }]),
	);
	assert.equal(result.ok, false);
	assert.ok(result.problems.some((p) => p.code === "tight_loop"));
});

/* --------------------------------------------------------------- warnings */

test("an unreachable step is a warning, not a refusal", () => {
	// Half-finished work has to be publishable, or people edit the live
	// version instead.
	const result = validateFlow(
		flow([
			{ id: "a", kind: "handover" },
			{ id: "orphan", kind: "message", text: "nobody gets here", next: null },
		]),
	);
	assert.equal(result.ok, true);
	const problem = result.problems.find((p) => p.code === "unreachable_step");
	assert.ok(problem);
	assert.equal(problem.severity, "warning");
	assert.equal(problem.stepId, "orphan");
});

test("a flow with no way to reach a person is flagged", () => {
	const result = validateFlow(
		flow([{ id: "a", kind: "end", text: "goodbye" }]),
	);
	assert.equal(result.ok, true);
	assert.ok(result.problems.some((p) => p.code === "no_route_to_a_person"));
});

/* ----------------------------------------------------------------- parsing */

test("a document that is not a flow is reported rather than cast", () => {
	assert.equal(parseSteps("not json").problems[0]?.code, "malformed_step");
	assert.equal(parseSteps('{"id":"a"}').problems[0]?.code, "malformed_step");
	assert.equal(
		parseSteps('[{"kind":"end"}]').problems[0]?.code,
		"malformed_step",
	);
	assert.equal(
		parseSteps('[{"id":"a","kind":"telepathy"}]').problems[0]?.code,
		"malformed_step",
	);
});

test("a question with no next step is dropped rather than half-built", () => {
	const parsed = parseSteps('[{"id":"a","kind":"ask","text":"?","slot":"s"}]');
	assert.equal(parsed.steps.length, 0);
	assert.match(parsed.problems[0]?.message ?? "", /where the answer leads/);
});

test("a flow survives the round trip through JSON", () => {
	const starter = buildStarterFlow({ id: "ksa", label: "KSA" });
	const parsed = parseSteps(JSON.stringify(starter.steps));
	assert.equal(parsed.problems.length, 0, JSON.stringify(parsed.problems));
	assert.equal(parsed.steps.length, starter.steps.length);
	assert.equal(validateFlow(flow(parsed.steps, starter.entryStepId)).ok, true);
});
