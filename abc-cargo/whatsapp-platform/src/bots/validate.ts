/**
 * Everything that must be true about a flow before it is allowed in front of a
 * customer.
 *
 * This runs at publish time, not at runtime, and that is the whole point. A
 * broken flow caught here is an error message for whoever edited it; the same
 * flow caught at runtime is a customer sitting in silence, or reading the same
 * menu for the fourth time, on a number that takes claims.
 *
 * Errors refuse the publish. Warnings do not — an unreachable branch is
 * usually a half-finished edit, and refusing to publish the rest of the flow
 * because of it would push people towards editing the live version instead.
 */

import {
	ANSWER_SHAPES,
	STEP_KINDS,
	type BotFlow,
	type BotStep,
} from "./types.ts";

export const PROBLEM_CODES = [
	"duplicate_step_id",
	"unknown_entry_step",
	"no_steps",
	"unknown_step_kind",
	"malformed_step",
	"dangling_next",
	"empty_text",
	"text_too_long",
	"empty_menu",
	"duplicate_menu_keyword",
	"missing_slot",
	"unknown_answer_shape",
	"tight_loop",
	"unreachable_step",
	"no_route_to_a_person",
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

export interface FlowProblem {
	severity: "error" | "warning";
	code: ProblemCode;
	stepId: string | null;
	message: string;
}

export interface FlowValidation {
	/** False when there is at least one error. Warnings do not block. */
	ok: boolean;
	problems: FlowProblem[];
}

/**
 * The Cloud API refuses a text body longer than this, so a step that exceeds
 * it is a message that will never arrive.
 */
export const MAX_TEXT_LENGTH = 4096;

/** Steps that stop and wait for the customer, ending the turn. */
const WAITING_KINDS = new Set(["ask", "menu"]);

export function validateFlow(flow: BotFlow): FlowValidation {
	const problems: FlowProblem[] = [];
	const error = (code: ProblemCode, stepId: string | null, message: string) =>
		problems.push({ severity: "error", code, stepId, message });
	const warn = (code: ProblemCode, stepId: string | null, message: string) =>
		problems.push({ severity: "warning", code, stepId, message });

	if (flow.steps.length === 0) {
		error("no_steps", null, "the flow has no steps");
		return { ok: false, problems };
	}

	const byId = new Map<string, BotStep>();
	for (const step of flow.steps) {
		if (byId.has(step.id)) {
			error(
				"duplicate_step_id",
				step.id,
				`two steps share the id "${step.id}"; one of them is unreachable and which one is undefined`,
			);
			continue;
		}
		byId.set(step.id, step);
	}

	if (!byId.has(flow.entryStepId)) {
		error(
			"unknown_entry_step",
			flow.entryStepId,
			`the flow starts at "${flow.entryStepId}", which is not a step in it`,
		);
	}

	/* ------------------------------------------------- each step on its own */

	for (const step of byId.values()) {
		if (!(STEP_KINDS as readonly string[]).includes(step.kind)) {
			error(
				"unknown_step_kind",
				step.id,
				`"${step.kind}" is not a step kind this platform runs`,
			);
			continue;
		}

		for (const target of targetsOf(step)) {
			if (target !== null && !byId.has(target)) {
				error(
					"dangling_next",
					step.id,
					`points at "${target}", which is not a step in this flow`,
				);
			}
		}

		const text = "text" in step ? step.text : undefined;
		if (
			step.kind === "message" ||
			step.kind === "ask" ||
			step.kind === "menu"
		) {
			if (!text || text.trim().length === 0) {
				error("empty_text", step.id, "has nothing to say");
			}
		}
		for (const [label, value] of textsOf(step)) {
			if (value && value.length > MAX_TEXT_LENGTH) {
				error(
					"text_too_long",
					step.id,
					`${label} is ${value.length} characters; WhatsApp refuses anything over ${MAX_TEXT_LENGTH}`,
				);
			}
		}

		if (step.kind === "ask") {
			if (step.slot.trim().length === 0) {
				error("missing_slot", step.id, "asks a question but keeps no answer");
			}
			if (
				step.expect !== undefined &&
				!(ANSWER_SHAPES as readonly string[]).includes(step.expect)
			) {
				error(
					"unknown_answer_shape",
					step.id,
					`expects "${step.expect}", which is not a shape this platform checks`,
				);
			}
		}

		if (step.kind === "menu") {
			if (step.options.length === 0) {
				error("empty_menu", step.id, "is a menu with no options");
			}
			// Two options claiming the same word is not a cosmetic clash: the
			// customer types it and reaches whichever option happens to be
			// listed first, which is not a decision anybody made.
			const seen = new Map<string, number>();
			for (const [index, option] of step.options.entries()) {
				for (const keyword of option.keywords) {
					const key = keyword.trim().toLowerCase();
					if (key.length === 0) continue;
					const first = seen.get(key);
					if (first !== undefined) {
						error(
							"duplicate_menu_keyword",
							step.id,
							`options ${first + 1} and ${index + 1} both answer to "${key}"`,
						);
					} else {
						seen.set(key, index);
					}
				}
			}
		}
	}

	/* ------------------------------------------------------ the shape of it */

	problems.push(...findTightLoops(byId, flow.entryStepId));

	const reachable = reachableFrom(byId, flow.entryStepId);
	for (const step of byId.values()) {
		if (!reachable.has(step.id) && step.id !== flow.entryStepId) {
			warn(
				"unreachable_step",
				step.id,
				"cannot be reached from the start of the flow",
			);
		}
	}

	const reachesAPerson = [...reachable]
		.map((id) => byId.get(id))
		.some((step) => step?.kind === "handover");
	if (!reachesAPerson) {
		warn(
			"no_route_to_a_person",
			null,
			"no reachable step hands the conversation to an agent; the bot can still be escaped by asking for one, but nothing in the flow offers it",
		);
	}

	return { ok: !problems.some((p) => p.severity === "error"), problems };
}

/** Every step a step can send the conversation to. */
export function targetsOf(step: BotStep): (string | null)[] {
	switch (step.kind) {
		case "message":
		case "create":
			return [step.next];
		case "ask":
			return [step.next];
		case "menu":
			return step.options.map((o) => o.next);
		case "classify":
			return [...Object.values(step.branches), step.otherwise];
		case "lookup":
			return [step.found, step.notFound];
		case "handover":
		case "end":
			return [];
	}
}

function textsOf(step: BotStep): [string, string | undefined][] {
	const out: [string, string | undefined][] = [];
	if ("text" in step) out.push(["the message", step.text]);
	if ("retryText" in step) out.push(["the retry message", step.retryText]);
	return out;
}

function reachableFrom(
	byId: Map<string, BotStep>,
	entryStepId: string,
): Set<string> {
	const seen = new Set<string>();
	const queue = [entryStepId];
	while (queue.length > 0) {
		const id = queue.pop();
		if (id === undefined || id === null || seen.has(id)) continue;
		const step = byId.get(id);
		if (!step) continue;
		seen.add(id);
		for (const target of targetsOf(step)) {
			if (target !== null && !seen.has(target)) queue.push(target);
		}
	}
	return seen;
}

/**
 * Finds a cycle the conversation could go round without ever stopping for the
 * customer.
 *
 * `ask` and `menu` end the turn, so a loop through either of them is an
 * ordinary repeat — a menu that returns to itself is how menus work. A loop
 * made only of steps that run straight through is the dangerous one: the
 * runtime's step budget would catch it and hand over, but the customer would
 * get a handover instead of an answer and nobody would know why.
 */
function findTightLoops(
	byId: Map<string, BotStep>,
	entryStepId: string,
): FlowProblem[] {
	const problems: FlowProblem[] = [];
	const reported = new Set<string>();
	// A step explored once without a cycle under it is safe under every later
	// path too, so this is kept across roots rather than reset with each one.
	const settled = new Set<string>();
	const rootsSeen = new Set<string>();
	const roots: string[] = [];

	const addRoot = (id: string): void => {
		if (rootsSeen.has(id)) return;
		rootsSeen.add(id);
		roots.push(id);
	};

	addRoot(entryStepId);
	// Unreachable subgraphs are checked too: they are usually about to be wired
	// in, and a loop found now is cheaper than one found after it is.
	for (const id of byId.keys()) addRoot(id);

	for (let i = 0; i < roots.length; i++) {
		const root = roots[i];
		if (root === undefined) continue;
		// `grey` is per root, because crossing a waiting step ends the turn and
		// with it the cycle: A → ask → A is an ordinary repeat, not a loop.
		const grey = new Set<string>();

		const walk = (id: string, path: string[]): void => {
			const step = byId.get(id);
			if (!step) return;

			if (grey.has(id)) {
				const from = path.indexOf(id);
				const cycle = from >= 0 ? path.slice(from) : [id];
				const key = [...cycle].sort().join(">");
				if (!reported.has(key)) {
					reported.add(key);
					problems.push({
						severity: "error",
						code: "tight_loop",
						stepId: id,
						message: `${cycle.join(" → ")} → ${id} runs round without ever waiting for the customer`,
					});
				}
				return;
			}
			if (settled.has(id)) return;

			// A waiting step ends the turn. Its targets start a new turn, so they
			// are examined as their own roots rather than under this grey stack.
			if (WAITING_KINDS.has(step.kind)) {
				settled.add(id);
				for (const target of targetsOf(step)) {
					if (target !== null) addRoot(target);
				}
				return;
			}

			grey.add(id);
			for (const target of targetsOf(step)) {
				if (target !== null) walk(target, [...path, id]);
			}
			grey.delete(id);
			settled.add(id);
		};

		walk(root, []);
	}

	return problems;
}
