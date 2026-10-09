/**
 * The test preview: a scripted conversation run against a flow.
 *
 * It calls `runTurn`, the same function a live message goes through. That is
 * the whole value of it. A preview written as its own walk of the step graph
 * would be a second implementation of the bot, and the two would drift — which
 * is how a flow comes to behave one way in the builder and another way in
 * front of a customer.
 *
 * Nothing here touches the database or the Cloud API. The effects a turn
 * produces are reported rather than carried out, so a draft can be exercised
 * against a live region's flow without a message leaving the building.
 */

import { runTurn } from "./runtime.ts";
import type {
	BotEffect,
	BotFacts,
	BotFlow,
	BotSession,
	BotTrace,
	SessionEndReason,
} from "./types.ts";
import { validateFlow, type FlowValidation } from "./validate.ts";

export interface PreviewMessage {
	text: string;
	/** What the platform would have known at this point, if anything. */
	facts?: BotFacts;
}

export interface PreviewTurn {
	/** The customer's message, as scripted. */
	customer: string;
	/** What the bot would send, in order. */
	replies: string[];
	/** Everything else the turn asked the platform to do. */
	effects: Exclude<BotEffect, { kind: "send_text" }>[];
	trace: BotTrace[];
	/** Where the session is left waiting, or null if it ended. */
	stepId: string | null;
	endedReason: SessionEndReason | null;
}

export interface PreviewResult {
	/** Run first, because a preview of an invalid flow is worth little. */
	validation: FlowValidation;
	turns: PreviewTurn[];
	/** The answers the flow collected by the end of the script. */
	slots: Record<string, string>;
	/** True if the conversation reached an agent. */
	handedOver: boolean;
}

/** A minute between messages, so a session's age behaves as it would live. */
const GAP_MS = 60_000;

export function previewFlow(input: {
	flow: BotFlow;
	messages: PreviewMessage[];
	/** Carry on from an existing session instead of starting fresh. */
	session?: BotSession | null;
	start?: Date;
}): PreviewResult {
	const validation = validateFlow(input.flow);
	const turns: PreviewTurn[] = [];
	let session: BotSession | null = input.session ?? null;
	let clock = (input.start ?? new Date("2026-01-01T09:00:00.000Z")).getTime();
	let handedOver = false;

	for (const message of input.messages) {
		const result = runTurn({
			flow: input.flow,
			session,
			text: message.text,
			facts: message.facts,
			now: new Date(clock),
		});
		session = result.session;
		clock += GAP_MS;

		const replies: string[] = [];
		const effects: PreviewTurn["effects"] = [];
		for (const effect of result.effects) {
			if (effect.kind === "send_text") replies.push(effect.text);
			else {
				effects.push(effect);
				if (effect.kind === "handover") handedOver = true;
			}
		}

		turns.push({
			customer: message.text,
			replies,
			effects,
			trace: result.trace,
			stepId: result.session.stepId,
			endedReason: result.session.endedReason,
		});
	}

	return {
		validation,
		turns,
		slots: session?.slots ?? {},
		handedOver,
	};
}
