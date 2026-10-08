/**
 * The bot: what a flow is, what a session is, and what a turn is allowed to do.
 *
 * Three decisions in here shape everything else, and all three exist because of
 * a specific way bot platforms go wrong.
 *
 * **A turn performs nothing.** The runtime reads a flow and a session and
 * returns a list of effects for the caller to carry out. Nothing is sent,
 * written or looked up inside it. That is what lets the test preview run the
 * same code as production rather than a sympathetic imitation of it — which is
 * the usual reason a flow behaves one way in the builder and another way in
 * front of a customer.
 *
 * **Facts come in, they are not fetched.** A step that branches on a shipment
 * needs the shipment, and a pure runtime cannot go and get one. The caller
 * already resolves references before this point, so it passes what it found.
 * When the shipment system is unreachable the facts are simply absent and the
 * "not found" branch runs, which is the behaviour we want anyway.
 *
 * **A session remembers which version of the flow it started on.** Publishing
 * a change must not move a customer who is halfway through answering a
 * question into a different conversation.
 */

import type { Intent } from "../crm/intent.ts";

export const STEP_KINDS = [
	"message",
	"ask",
	"menu",
	"classify",
	"lookup",
	"create",
	"handover",
	"end",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** What an `ask` step will accept as an answer. */
export const ANSWER_SHAPES = ["any", "reference", "number", "email"] as const;
export type AnswerShape = (typeof ANSWER_SHAPES)[number];

export interface MenuOption {
	/** What the customer may type instead of the number, case-insensitive. */
	keywords: string[];
	label: string;
	next: string;
}

/**
 * One step of a flow.
 *
 * `message`, `create` and `lookup` run straight through; `ask` and `menu` stop
 * and wait for the customer; `handover` and `end` finish the session.
 */
export type BotStep =
	| { id: string; kind: "message"; text: string; next: string | null }
	| {
			id: string;
			kind: "ask";
			text: string;
			/** Where the answer is kept, for later steps and for the handover note. */
			slot: string;
			expect?: AnswerShape;
			/** Sent when the answer is the wrong shape. */
			retryText?: string;
			next: string;
	  }
	| {
			id: string;
			kind: "menu";
			text: string;
			options: MenuOption[];
			retryText?: string;
	  }
	| {
			id: string;
			kind: "classify";
			/** Intent to step. An intent with no branch falls to `otherwise`. */
			branches: Partial<Record<Intent, string>>;
			otherwise: string;
	  }
	| {
			id: string;
			kind: "lookup";
			/** Taken from this slot, or from the references in the message. */
			slot?: string;
			found: string;
			notFound: string;
	  }
	| {
			id: string;
			kind: "create";
			create: "lead" | "ticket";
			/** Ticket type; ignored for a lead. */
			ticketType?:
				"claim" | "billing" | "documentation" | "delivery" | "general";
			next: string | null;
	  }
	| {
			id: string;
			kind: "handover";
			/** Shown to the customer before the conversation reaches a person. */
			text?: string;
			/** Which regional queue takes it. Defaults to the region's own. */
			queue?: string;
	  }
	| { id: string; kind: "end"; text?: string };

export const FLOW_STATUSES = ["draft", "published", "retired"] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

/**
 * A flow belongs to one region, which is to say one WhatsApp number. The three
 * numbers front three different operations with different hours, different
 * queues and different languages, and a shared flow with regional exceptions
 * threaded through it would be worse than three flows.
 */
export interface BotFlow {
	id: string;
	regionId: string;
	name: string;
	version: number;
	status: FlowStatus;
	entryStepId: string;
	steps: BotStep[];
}

export const SESSION_END_REASONS = [
	"completed",
	"handover",
	"customer_asked_for_agent",
	"too_many_invalid_replies",
	"flow_stuck",
	"expired",
] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

export interface BotSession {
	flowId: string;
	/** The version this session started on, and will finish on. */
	flowVersion: number;
	/** The step waiting for the customer. Null once the session has ended. */
	stepId: string | null;
	slots: Record<string, string>;
	/** Consecutive unusable answers at the current step, not the whole session. */
	invalidReplies: number;
	turns: number;
	startedAt: string;
	updatedAt: string;
	endedAt: string | null;
	endedReason: SessionEndReason | null;
}

/** What the caller already knows, so the runtime does not have to ask. */
export interface BotFacts {
	/** The shipment a reference in the message pointed at, if we hold it. */
	booking?: {
		ref: string;
		/** Written for a customer to read, not the stored identifier. */
		milestone: string | null;
		/** When the milestone was recorded. The platform holds no ETA. */
		updatedAt?: string | null;
	} | null;
	/** References found in the message, normalised. */
	references?: string[];
	contactName?: string | null;
}

export type BotEffect =
	| { kind: "send_text"; text: string }
	| { kind: "open_lead"; source: string }
	| {
			kind: "open_ticket";
			type: "claim" | "billing" | "documentation" | "delivery" | "general";
			subject: string;
	  }
	| {
			kind: "handover";
			queue: string | null;
			reason: SessionEndReason;
			/** The answers collected so far, so the agent does not re-ask them. */
			slots: Record<string, string>;
	  };

/** One line of the record of why the bot did what it did. */
export interface BotTrace {
	stepId: string;
	kind: StepKind | "escape" | "budget";
	note: string;
}

export interface BotTurnResult {
	session: BotSession;
	effects: BotEffect[];
	trace: BotTrace[];
}
