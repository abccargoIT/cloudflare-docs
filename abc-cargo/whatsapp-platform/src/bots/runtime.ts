/**
 * The interpreter. One inbound message in, a new session and a list of effects
 * out, and nothing performed along the way.
 *
 * Four rules in here are not negotiable, and each exists because of a specific
 * thing that happens to customers on bot-fronted numbers:
 *
 * 1. **Asking for a person always works.** Checked on every turn, at whatever
 *    step the session is sitting on, whether or not the flow offers it. On a
 *    number that takes damage claims this is the single most important rule in
 *    the file.
 * 2. **A menu gives up.** After a small number of answers it cannot use, the
 *    conversation goes to an agent instead of printing the menu again. The
 *    third identical menu is the point at which a customer stops replying and
 *    starts telephoning, and nobody finds out why.
 * 3. **A turn has a step budget.** A flow that runs round without waiting is
 *    refused at publish time, but a flow published before that check existed,
 *    or one hand-written into the database, must still not spin.
 * 4. **A session keeps its version.** Publishing a new flow does not move a
 *    customer who is halfway through answering a question.
 */

import { extractTrackingNumbers } from "../auto-reply.ts";
import { classifyIntent } from "../crm/intent.ts";
import type {
	BotEffect,
	BotFacts,
	BotFlow,
	BotSession,
	BotStep,
	BotTrace,
	BotTurnResult,
	SessionEndReason,
} from "./types.ts";

/**
 * Answers at one step before the conversation goes to a person. Two retries,
 * then a human: enough for a typo, not enough to be an experience.
 */
export const MAX_INVALID_REPLIES = 2;

/** Steps one message may run through before the runtime gives up on the flow. */
export const MAX_STEPS_PER_TURN = 16;

/**
 * How long a half-finished session stays resumable. Tied to the WhatsApp
 * customer service window on purpose: past it the conversation itself has
 * lapsed, and resuming "which reference was that?" a day later reads as a
 * machine with no memory of the gap.
 */
export const SESSION_TTL_HOURS = 24;

export interface BotTurnInput {
	flow: BotFlow;
	/** Null, or a session that has ended, starts the flow from the beginning. */
	session: BotSession | null;
	text: string | undefined;
	facts?: BotFacts;
	now: Date;
}

export function runTurn(input: BotTurnInput): BotTurnResult {
	const { flow, now } = input;
	const facts = input.facts ?? {};
	const nowIso = now.toISOString();
	const effects: BotEffect[] = [];
	const trace: BotTrace[] = [];
	const byId = new Map(flow.steps.map((step) => [step.id, step]));

	let session =
		resumableSession(input.session, flow, now) ?? freshSession(flow, nowIso);
	session = { ...session, turns: session.turns + 1, updatedAt: nowIso };

	const say = (text: string): void => {
		const rendered = render(text, session.slots, facts);
		if (rendered.trim().length > 0)
			effects.push({ kind: "send_text", text: rendered });
	};

	const finish = (
		reason: SessionEndReason,
		queue?: string | null,
	): BotTurnResult => {
		if (reason !== "completed") {
			effects.push({
				kind: "handover",
				queue: queue ?? null,
				reason,
				// The answers already given, so the agent opens the conversation
				// knowing them rather than asking again.
				slots: { ...session.slots },
			});
		}
		return {
			session: {
				...session,
				stepId: null,
				endedAt: nowIso,
				endedReason: reason,
			},
			effects,
			trace,
		};
	};

	/* ------------------------------------------ the answer to a waiting step */

	let cursor: string | null;
	const waiting =
		session.stepId === null ? null : (byId.get(session.stepId) ?? null);

	if (waiting && (waiting.kind === "ask" || waiting.kind === "menu")) {
		const answered = acceptAnswer(waiting, input.text, session);
		if (answered.escape) {
			trace.push({ stepId: waiting.id, kind: "escape", note: answered.note });
			say(ASKED_FOR_A_PERSON);
			return finish("customer_asked_for_agent");
		}
		if (!answered.accepted) {
			const invalidReplies = session.invalidReplies + 1;
			session = { ...session, invalidReplies };
			trace.push({
				stepId: waiting.id,
				kind: waiting.kind,
				note: answered.note,
			});
			if (invalidReplies > MAX_INVALID_REPLIES) {
				say(GIVING_UP);
				return finish("too_many_invalid_replies");
			}
			say(answered.retryText ?? defaultRetry(waiting));
			return { session, effects, trace };
		}
		session = { ...session, slots: answered.slots, invalidReplies: 0 };
		trace.push({ stepId: waiting.id, kind: waiting.kind, note: answered.note });
		cursor = answered.next;
	} else {
		// Nothing is waiting, so this message starts the flow. The escape is
		// still checked: a first message of "I need to speak to someone" should
		// not be answered with a greeting and a menu.
		if (asksForAPerson(input.text)) {
			trace.push({
				stepId: flow.entryStepId,
				kind: "escape",
				note: "asked for an agent before the flow started",
			});
			say(ASKED_FOR_A_PERSON);
			return finish("customer_asked_for_agent");
		}
		cursor = session.stepId ?? flow.entryStepId;
	}

	/* ------------------------------------------------- run forward from here */

	let budget = MAX_STEPS_PER_TURN;
	let lastStepId = session.stepId ?? flow.entryStepId;
	while (cursor !== null) {
		if (budget-- <= 0) {
			// Should be unreachable: validateFlow refuses a flow that can do
			// this. Reachable anyway for a flow written straight into the
			// database, and silence would be the worst possible answer.
			trace.push({
				stepId: cursor,
				kind: "budget",
				note: `stopped after ${MAX_STEPS_PER_TURN} steps without waiting for the customer`,
			});
			say(SOMETHING_WRONG);
			return finish("flow_stuck");
		}

		lastStepId = cursor;
		const step: BotStep | undefined = byId.get(cursor);
		if (!step) {
			// A published flow cannot have a dangling target either, so this is
			// the same class of problem and gets the same treatment.
			trace.push({
				stepId: cursor,
				kind: "budget",
				note: `step "${cursor}" is not in this flow`,
			});
			say(SOMETHING_WRONG);
			return finish("flow_stuck");
		}

		switch (step.kind) {
			case "message": {
				say(step.text);
				trace.push({ stepId: step.id, kind: "message", note: "sent" });
				cursor = step.next;
				break;
			}

			case "ask": {
				say(step.text);
				trace.push({
					stepId: step.id,
					kind: "ask",
					note: `waiting for ${step.slot}`,
				});
				return {
					session: { ...session, stepId: step.id, invalidReplies: 0 },
					effects,
					trace,
				};
			}

			case "menu": {
				say(
					withOptions(
						step.text,
						step.options.map((o) => o.label),
					),
				);
				trace.push({
					stepId: step.id,
					kind: "menu",
					note: `waiting on ${step.options.length} options`,
				});
				return {
					session: { ...session, stepId: step.id, invalidReplies: 0 },
					effects,
					trace,
				};
			}

			case "classify": {
				const result = classifyIntent(input.text);
				const branch = step.branches[result.intent];
				trace.push({
					stepId: step.id,
					kind: "classify",
					note: `${result.intent} at ${result.confidence}${branch ? "" : " → otherwise"}`,
				});
				cursor = branch ?? step.otherwise;
				break;
			}

			case "lookup": {
				const wanted = step.slot
					? session.slots[step.slot]
					: (facts.references ?? [])[0];
				const booking = facts.booking ?? null;
				// Found means the caller handed us the shipment. A reference the
				// customer typed that we hold no record of is "not found", which
				// is also what an unreachable shipment system looks like — and
				// the branch an author writes for one serves the other.
				const found = Boolean(booking) && wanted !== undefined;
				trace.push({
					stepId: step.id,
					kind: "lookup",
					note: found
						? `matched ${booking?.ref}`
						: `no shipment for ${wanted ?? "no reference"}`,
				});
				cursor = found ? step.found : step.notFound;
				break;
			}

			case "create": {
				if (step.create === "lead") {
					effects.push({ kind: "open_lead", source: "whatsapp_bot" });
				} else {
					effects.push({
						kind: "open_ticket",
						type: step.ticketType ?? "general",
						subject: subjectFrom(session.slots, step.ticketType ?? "general"),
					});
				}
				trace.push({
					stepId: step.id,
					kind: "create",
					note: `queued a ${step.create}`,
				});
				cursor = step.next;
				break;
			}

			case "handover": {
				if (step.text) say(step.text);
				trace.push({ stepId: step.id, kind: "handover", note: "to an agent" });
				return finish("handover", step.queue ?? null);
			}

			case "end": {
				if (step.text) say(step.text);
				trace.push({ stepId: step.id, kind: "end", note: "flow finished" });
				return finish("completed");
			}
		}
	}

	// `next: null` is a deliberate finish, not a fault.
	trace.push({ stepId: lastStepId, kind: "end", note: "flow ran to its end" });
	return finish("completed");
}

/* ------------------------------------------------------------------ answers */

interface Answer {
	accepted: boolean;
	escape: boolean;
	next: string | null;
	slots: Record<string, string>;
	retryText?: string;
	note: string;
}

function acceptAnswer(
	step: Extract<BotStep, { kind: "ask" } | { kind: "menu" }>,
	text: string | undefined,
	session: BotSession,
): Answer {
	const raw = (text ?? "").trim();
	const base = {
		slots: session.slots,
		next: null as string | null,
		escape: false,
	};

	if (step.kind === "menu") {
		// A matching option wins over the escape hatch. If the flow's author
		// put "agent" on an option, that option is what they meant to happen.
		const chosen = matchOption(step.options, raw);
		if (chosen) {
			return {
				...base,
				accepted: true,
				next: chosen.option.next,
				slots: { ...session.slots, [`${step.id}_choice`]: chosen.option.label },
				note: `chose "${chosen.option.label}" by ${chosen.how}`,
			};
		}
		if (asksForAPerson(raw)) {
			return {
				...base,
				accepted: false,
				escape: true,
				note: "asked for an agent at a menu",
			};
		}
		return {
			...base,
			accepted: false,
			retryText: step.retryText,
			note:
				raw.length === 0
					? "empty reply at a menu"
					: `"${raw}" matched no option`,
		};
	}

	if (asksForAPerson(raw)) {
		return {
			...base,
			accepted: false,
			escape: true,
			note: "asked for an agent at a question",
		};
	}

	const value = shapeAnswer(raw, step.expect ?? "any");
	if (value === null) {
		return {
			...base,
			accepted: false,
			retryText: step.retryText,
			note:
				raw.length === 0 ? "empty answer" : `"${raw}" is not a ${step.expect}`,
		};
	}
	return {
		...base,
		accepted: true,
		next: step.next,
		slots: { ...session.slots, [step.slot]: value },
		note: `${step.slot} = ${value}`,
	};
}

/**
 * The answer in the form it should be stored, or null if it is unusable.
 *
 * A reference is stored normalised, because that is the form that matches a
 * record; the customer's own spelling is already in the message history.
 */
function shapeAnswer(
	raw: string,
	expect: NonNullable<Extract<BotStep, { kind: "ask" }>["expect"]>,
): string | null {
	if (raw.length === 0) return null;
	switch (expect) {
		case "any":
			return raw;
		case "reference": {
			const found = extractTrackingNumbers(raw);
			return found[0] ?? null;
		}
		case "number": {
			const digits = raw.replace(/[^\d.]/g, "");
			return digits.length > 0 && Number.isFinite(Number(digits))
				? digits
				: null;
		}
		case "email": {
			const at = raw.indexOf("@");
			if (at <= 0 || at !== raw.lastIndexOf("@")) return null;
			return at < raw.length - 1 && !/\s/.test(raw) ? raw.toLowerCase() : null;
		}
	}
}

function matchOption(
	options: Extract<BotStep, { kind: "menu" }>["options"],
	raw: string,
): { option: (typeof options)[number]; how: string } | null {
	if (raw.length === 0) return null;

	// The number as printed, which is how most people answer a menu.
	const asNumber = Number(raw);
	if (
		Number.isInteger(asNumber) &&
		asNumber >= 1 &&
		asNumber <= options.length
	) {
		const option = options[asNumber - 1];
		if (option) return { option, how: "number" };
	}

	const lowered = raw.toLowerCase();
	for (const option of options) {
		for (const keyword of option.keywords) {
			const key = keyword.trim().toLowerCase();
			if (key.length === 0) continue;
			if (lowered === key) return { option, how: `keyword "${key}"` };
		}
	}
	// A keyword inside a longer sentence, checked only after exact matches so
	// "2" never loses to an option whose keyword happens to contain it.
	for (const option of options) {
		for (const keyword of option.keywords) {
			const key = keyword.trim().toLowerCase();
			if (key.length > 2 && lowered.includes(key)) {
				return { option, how: `keyword "${key}"` };
			}
		}
	}
	return null;
}

/**
 * Whether the customer is asking for a person.
 *
 * Delegates to the platform's own classifier so the bot and the routing rules
 * cannot come to different conclusions about the same sentence.
 */
export function asksForAPerson(text: string | undefined): boolean {
	if (!text || text.trim().length === 0) return false;
	return classifyIntent(text).intent === "agent";
}

/* ----------------------------------------------------------------- sessions */

function freshSession(flow: BotFlow, nowIso: string): BotSession {
	return {
		flowId: flow.id,
		flowVersion: flow.version,
		stepId: null,
		slots: {},
		invalidReplies: 0,
		turns: 0,
		startedAt: nowIso,
		updatedAt: nowIso,
		endedAt: null,
		endedReason: null,
	};
}

/**
 * The session to carry on with, or null to start again.
 *
 * A session from a different flow version is not resumed. The step it is
 * sitting on may not exist in the new version, and worse, it may exist and
 * mean something else.
 */
export function resumableSession(
	session: BotSession | null,
	flow: BotFlow,
	now: Date,
): BotSession | null {
	if (!session || session.endedAt !== null || session.stepId === null)
		return null;
	if (session.flowId !== flow.id || session.flowVersion !== flow.version)
		return null;
	const updated = Date.parse(session.updatedAt);
	if (!Number.isFinite(updated)) return null;
	const hours = (now.getTime() - updated) / 3_600_000;
	return hours >= 0 && hours < SESSION_TTL_HOURS ? session : null;
}

/* -------------------------------------------------------------------- text */

const ASKED_FOR_A_PERSON =
	"Of course — I am passing you to a member of our team now. They will reply here.";
const GIVING_UP =
	"I am sorry, I am not following. Let me pass you to a member of our team.";
const SOMETHING_WRONG =
	"Something has gone wrong at our end. I am passing you to a member of our team.";

/**
 * Fills `{{slot}}` placeholders.
 *
 * An unknown placeholder renders as nothing rather than as itself. "Hello," is
 * an awkward sentence; "Hello {{name}}," is a customer reading our source code.
 */
export function render(
	text: string,
	slots: Record<string, string>,
	facts: BotFacts,
): string {
	const values: Record<string, string> = {
		...slots,
		"contact.name": facts.contactName ?? "",
		"booking.ref": facts.booking?.ref ?? "",
		"booking.milestone": facts.booking?.milestone ?? "",
		"booking.updated": facts.booking?.updatedAt ?? "",
	};
	return text
		.replace(
			/\{\{\s*([\w.]+)\s*\}\}/g,
			(_match, name: string) => values[name] ?? "",
		)
		.replace(/[ \t]{2,}/g, " ")
		.replace(/ +([,.!?])/g, "$1")
		.trim();
}

function withOptions(text: string, labels: string[]): string {
	if (labels.length === 0) return text;
	return [text, "", ...labels.map((label, i) => `${i + 1}. ${label}`)].join(
		"\n",
	);
}

function defaultRetry(
	step: Extract<BotStep, { kind: "ask" } | { kind: "menu" }>,
): string {
	if (step.kind === "menu") {
		return withOptions(
			"Sorry, I did not catch that. Please reply with the number of one of these:",
			step.options.map((o) => o.label),
		);
	}
	switch (step.expect ?? "any") {
		case "reference":
			return "Could you send the shipment reference? It looks like ABC-UAE-088210.";
		case "number":
			return "Could you reply with a number?";
		case "email":
			return "Could you send an email address?";
		case "any":
			return "Sorry, I did not catch that. Could you say it again?";
	}
}

function subjectFrom(slots: Record<string, string>, type: string): string {
	const first = Object.values(slots).find((v) => v.trim().length > 0);
	return first
		? `${type}: ${first.slice(0, 120)}`
		: `${type} raised on WhatsApp`;
}
