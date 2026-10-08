/**
 * Turning a JSON document into a flow, or saying exactly why it is not one.
 *
 * Flows arrive from two places — the editor, over the API, and the `steps`
 * column of the database — and neither is trustworthy enough to cast. A field
 * of the wrong type here surfaces as a runtime exception halfway through a
 * customer's conversation, which is the worst place to find out. So the shape
 * is checked once, at the boundary, and the runtime is allowed to assume it
 * afterwards.
 *
 * This file answers "is it a flow at all"; `validate.ts` answers "is it a flow
 * that should be put in front of a customer".
 */

import {
	ANSWER_SHAPES,
	STEP_KINDS,
	type AnswerShape,
	type BotStep,
	type MenuOption,
} from "./types.ts";
import type { FlowProblem } from "./validate.ts";

export interface ParsedSteps {
	steps: BotStep[];
	problems: FlowProblem[];
}

type TicketType = NonNullable<
	Extract<BotStep, { kind: "create" }>["ticketType"]
>;

const TICKET_TYPES: TicketType[] = [
	"claim",
	"billing",
	"documentation",
	"delivery",
	"general",
];

const bad = (stepId: string | null, message: string): FlowProblem => ({
	severity: "error",
	code: "malformed_step",
	stepId,
	message,
});

export function parseSteps(input: unknown): ParsedSteps {
	const problems: FlowProblem[] = [];
	const steps: BotStep[] = [];

	let raw: unknown = input;
	if (typeof input === "string") {
		try {
			raw = JSON.parse(input);
		} catch {
			return {
				steps: [],
				problems: [bad(null, "the steps are not valid JSON")],
			};
		}
	}
	if (!Array.isArray(raw)) {
		return {
			steps: [],
			problems: [bad(null, "the steps must be a JSON array")],
		};
	}

	for (const [index, item] of raw.entries()) {
		const where = `step ${index + 1}`;
		if (typeof item !== "object" || item === null) {
			problems.push(bad(null, `${where} is not an object`));
			continue;
		}
		const obj = item as Record<string, unknown>;
		const id = obj["id"];
		if (typeof id !== "string" || id.trim().length === 0) {
			problems.push(bad(null, `${where} has no id`));
			continue;
		}
		const kind = obj["kind"];
		if (
			typeof kind !== "string" ||
			!(STEP_KINDS as readonly string[]).includes(kind)
		) {
			problems.push(
				bad(id, `"${String(kind)}" is not a step kind this platform runs`),
			);
			continue;
		}

		const step = coerce(id, kind as BotStep["kind"], obj, problems);
		if (step) steps.push(step);
	}

	return { steps, problems };
}

function coerce(
	id: string,
	kind: BotStep["kind"],
	obj: Record<string, unknown>,
	problems: FlowProblem[],
): BotStep | null {
	const text = str(obj["text"]);
	const next = target(obj["next"]);

	switch (kind) {
		case "message":
			return { id, kind, text: text ?? "", next };

		case "ask": {
			if (next === null) {
				problems.push(bad(id, "a question must say where the answer leads"));
				return null;
			}
			const expect = str(obj["expect"]);
			if (
				expect !== undefined &&
				!(ANSWER_SHAPES as readonly string[]).includes(expect)
			) {
				problems.push(
					bad(
						id,
						`expects "${expect}", which is not a shape this platform checks`,
					),
				);
				return null;
			}
			return {
				id,
				kind: "ask",
				text: text ?? "",
				slot: str(obj["slot"]) ?? "",
				expect: expect as AnswerShape | undefined,
				retryText: str(obj["retryText"]),
				next,
			};
		}

		case "menu": {
			const rawOptions = obj["options"];
			if (!Array.isArray(rawOptions)) {
				problems.push(bad(id, "a menu needs an options array"));
				return null;
			}
			const options: MenuOption[] = [];
			for (const [i, rawOption] of rawOptions.entries()) {
				if (typeof rawOption !== "object" || rawOption === null) {
					problems.push(bad(id, `option ${i + 1} is not an object`));
					continue;
				}
				const o = rawOption as Record<string, unknown>;
				const label = str(o["label"]);
				const optionNext = target(o["next"]);
				if (!label || optionNext === null) {
					problems.push(
						bad(id, `option ${i + 1} needs a label and a next step`),
					);
					continue;
				}
				const keywords = Array.isArray(o["keywords"])
					? o["keywords"].filter((k): k is string => typeof k === "string")
					: [];
				options.push({ label, next: optionNext, keywords });
			}
			return {
				id,
				kind,
				text: text ?? "",
				options,
				retryText: str(obj["retryText"]),
			};
		}

		case "classify": {
			const rawBranches = obj["branches"];
			const branches: Record<string, string> = {};
			if (rawBranches !== undefined) {
				if (typeof rawBranches !== "object" || rawBranches === null) {
					problems.push(
						bad(id, "branches must be an object of intent to step"),
					);
					return null;
				}
				for (const [intent, value] of Object.entries(rawBranches)) {
					const to = target(value);
					if (to === null) {
						problems.push(bad(id, `the "${intent}" branch has no step`));
						continue;
					}
					branches[intent] = to;
				}
			}
			const otherwise = target(obj["otherwise"]);
			if (otherwise === null) {
				problems.push(bad(id, "a classify step needs an otherwise branch"));
				return null;
			}
			return { id, kind: "classify", branches, otherwise };
		}

		case "lookup": {
			const found = target(obj["found"]);
			const notFound = target(obj["notFound"]);
			if (found === null || notFound === null) {
				problems.push(
					bad(id, "a lookup needs both a found and a notFound step"),
				);
				return null;
			}
			return { id, kind, slot: str(obj["slot"]), found, notFound };
		}

		case "create": {
			const create = str(obj["create"]);
			if (create !== "lead" && create !== "ticket") {
				problems.push(bad(id, 'create must be "lead" or "ticket"'));
				return null;
			}
			const ticketType = str(obj["ticketType"]);
			if (
				ticketType !== undefined &&
				!(TICKET_TYPES as string[]).includes(ticketType)
			) {
				problems.push(
					bad(id, `"${ticketType}" is not a ticket type this platform opens`),
				);
				return null;
			}
			return {
				id,
				kind: "create",
				create,
				ticketType: ticketType as TicketType | undefined,
				next,
			};
		}

		case "handover":
			return { id, kind, text, queue: str(obj["queue"]) };

		case "end":
			return { id, kind, text };
	}
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** A step id, or null when there is no usable one. Empty strings count as none. */
function target(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}
