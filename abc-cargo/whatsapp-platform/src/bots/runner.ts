/**
 * Where the pure runtime meets the live platform.
 *
 * Everything that touches the outside world is here, and nothing else is: the
 * decisions were all taken by `runTurn`, and this only carries them out. Kept
 * separate so the rules stay testable without a database, a queue or a
 * WhatsApp token.
 *
 * **The bot is inert until a flow is published.** With no published flow for a
 * region, `handleInbound` returns `handled: false` and the caller does exactly
 * what it did before this file existed. That is deliberate: it means adding
 * the bot to the platform changes nothing on a live number until somebody
 * decides it should.
 */

import type { Conversation } from "../conversation.ts";
import type { CrmService } from "../crm/service.ts";
import type { RegionConfig } from "../regions.ts";
import { runTurn, SESSION_TTL_HOURS } from "./runtime.ts";
import { BotService } from "./service.ts";
import type { BotFacts, BotSession, SessionEndReason } from "./types.ts";

export interface BotOutcome {
	/** False when there is no published flow, or the message was a duplicate. */
	handled: boolean;
	/** True when the conversation has been passed to an agent. */
	handedOver: boolean;
	replies: number;
}

const NOT_HANDLED: BotOutcome = {
	handled: false,
	handedOver: false,
	replies: 0,
};

/** End reasons that put the conversation in a person's hands. */
const HANDED_TO_A_PERSON: ReadonlySet<SessionEndReason> = new Set([
	"handover",
	"customer_asked_for_agent",
	"too_many_invalid_replies",
	"flow_stuck",
]);

/**
 * Whether a conversation the bot handed over is still a person's.
 *
 * Once the bot has passed a conversation to an agent, the customer's next
 * message is for the agent. Without this the next message would start the
 * flow again from the top, and a customer halfway through explaining a claim
 * to a colleague would be sent the welcome menu.
 *
 * It stops being a person's when the conversation is resolved — the next
 * message is a new enquiry — or when the session lifetime has passed since the
 * handover, so a customer who comes back days later is greeted rather than
 * left waiting on a handover nobody remembers.
 */
export function heldByPerson(
	session: BotSession | null,
	conversationStatus: string | null,
	now: Date,
): boolean {
	if (!session || session.endedAt === null || session.endedReason === null) {
		return false;
	}
	if (!HANDED_TO_A_PERSON.has(session.endedReason)) return false;
	if (conversationStatus === null || conversationStatus === "resolved") {
		return false;
	}
	const ended = Date.parse(session.endedAt);
	if (!Number.isFinite(ended)) return false;
	const hours = (now.getTime() - ended) / 3_600_000;
	return hours >= 0 && hours < SESSION_TTL_HOURS;
}

export class BotRunner {
	private readonly db: D1Database;
	private readonly bots: BotService;
	private readonly crm: CrmService;

	constructor(db: D1Database, crm: CrmService) {
		this.db = db;
		this.bots = new BotService(db);
		this.crm = crm;
	}

	/** Whether this region has a bot at all, which decides the inbound path. */
	async hasPublishedFlow(regionId: string): Promise<boolean> {
		const loaded = await this.bots.publishedFlow(regionId);
		return loaded !== null && loaded.ok;
	}

	async handleInbound(input: {
		conversationId: string;
		region: RegionConfig;
		customerId?: string | null;
		text: string | undefined;
		facts?: BotFacts;
		conversation: DurableObjectStub<Conversation>;
		/** True when this message reopened a resolved conversation. */
		reopened?: boolean;
		now?: Date;
	}): Promise<BotOutcome> {
		const now = input.now ?? new Date();
		const session = await this.bots.session(input.conversationId);

		// Handed over and not yet resolved: the bot stays out of it, and the
		// customer is treated exactly as on a number with no bot — including
		// the out-of-hours reply, which has its own cooldown.
		// The status is read after the message was stored, which reopens a
		// resolved conversation; `reopened` says that is what just happened.
		if (
			!input.reopened &&
			heldByPerson(
				session,
				await this.conversationStatus(input.conversationId),
				now,
			)
		) {
			try {
				await input.conversation.autoReplyIfNeeded();
			} catch (error) {
				console.warn("automated reply after handover failed", {
					conversationId: input.conversationId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return { handled: true, handedOver: false, replies: 0 };
		}

		// A session mid-flow is answered by the version it started on, even
		// after a new one has been published. The step it is waiting at may not
		// exist in the new version — or, worse, may exist and mean something
		// else.
		const loaded = await this.flowFor(input.region.id, session);
		if (!loaded) return NOT_HANDLED;

		const result = runTurn({
			flow: loaded,
			session,
			text: input.text,
			facts: input.facts,
			now,
		});

		let replies = 0;
		let handedOver = false;
		for (const effect of result.effects) {
			switch (effect.kind) {
				case "send_text": {
					// One failed send does not abandon the rest of the turn: the
					// customer having been told two of three things is better
					// than the session recording a state they never reached.
					try {
						await input.conversation.sendBotText(effect.text);
						replies++;
					} catch (error) {
						console.error("bot reply failed", {
							conversationId: input.conversationId,
							error: error instanceof Error ? error.message : String(error),
						});
					}
					break;
				}
				case "open_lead": {
					// The CRM has already opened a lead for a rate enquiry by the
					// time this runs, and it will not open a second one while the
					// first is in play. Calling it again is how the flow stays
					// correct when the classifier did not reach the same
					// conclusion the flow's author did.
					await this.openLead(input, effect.source);
					break;
				}
				case "open_ticket": {
					await this.openTicket(input, effect.type, effect.subject);
					break;
				}
				case "handover": {
					handedOver = true;
					break;
				}
			}
		}

		await this.bots.saveSession({
			conversationId: input.conversationId,
			customerId: input.customerId ?? null,
			regionId: input.region.id,
			session: result.session,
		});
		await this.bots.recordTurn({
			conversationId: input.conversationId,
			regionId: input.region.id,
			flowId: loaded.id,
			flowVersion: loaded.version,
			fromStepId: session?.stepId ?? null,
			toStepId: result.session.stepId,
			endedReason: result.session.endedReason,
			trace: result.trace,
			now,
		});

		// Told a colleague will reply, and then nothing until the office opens,
		// with no idea when that is — this is the message that fills that gap.
		if (handedOver) {
			try {
				await input.conversation.autoReplyIfNeeded();
			} catch (error) {
				console.warn("post-handover automated reply failed", {
					conversationId: input.conversationId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return { handled: true, handedOver, replies };
	}

	/** The conversation's status, or null if it cannot be read. */
	private async conversationStatus(
		conversationId: string,
	): Promise<string | null> {
		try {
			const row = await this.db
				.prepare(`SELECT status FROM conversations WHERE id = ?1`)
				.bind(conversationId)
				.first<{ status: string }>();
			return row?.status ?? null;
		} catch (error) {
			// Unknown is treated as not held, so the bot answers. A greeting
			// the customer did not need is a smaller failure than silence.
			console.error("could not read the conversation status", {
				conversationId,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * The flow to answer with: the version a live session started on, or the
	 * published one for a conversation that has no session yet.
	 */
	private async flowFor(regionId: string, session: BotSession | null) {
		if (session && session.endedAt === null && session.stepId !== null) {
			const pinned = await this.bots.flowVersion(regionId, session.flowVersion);
			if (pinned?.ok) return pinned.flow;
			// The version is gone, which should not happen — nothing deletes a
			// flow. Falling through to the published one is better than silence,
			// and `resumableSession` will refuse to resume into it, so the
			// customer starts again rather than landing on a step at random.
			console.warn("bot session points at a missing flow version", {
				regionId,
				flowVersion: session.flowVersion,
			});
		}
		const published = await this.bots.publishedFlow(regionId);
		if (!published) return null;
		if (!published.ok) {
			// A published flow that no longer parses. Refusing to run it leaves
			// the ordinary automated reply and the agent queue, which is the
			// right failure.
			console.error("the published flow could not be read", {
				regionId,
				problems: published.problems,
			});
			return null;
		}
		return published.flow;
	}

	private async openLead(
		input: {
			region: RegionConfig;
			conversationId: string;
			customerId?: string | null;
		},
		source: string,
	): Promise<void> {
		const customer = await this.customer(input.customerId);
		if (!customer) return;
		await this.crm.openLeadIfNoneOpen({
			customer,
			regionId: input.region.id,
			conversationId: input.conversationId,
			source,
		});
	}

	private async openTicket(
		input: {
			region: RegionConfig;
			conversationId: string;
			customerId?: string | null;
		},
		type: "claim" | "billing" | "documentation" | "delivery" | "general",
		subject: string,
	): Promise<void> {
		const customer = await this.customer(input.customerId);
		if (!customer) return;
		await this.crm.openTicketIfNoneOpen({
			customer,
			region: input.region,
			type,
			subject,
			priority: type === "claim" ? "high" : "normal",
			bookingId: null,
			conversationId: input.conversationId,
		});
	}

	/**
	 * The customer record an effect applies to.
	 *
	 * Null means the effect is skipped rather than guessed at. A ticket on the
	 * wrong customer is worse than no ticket, because somebody will work it.
	 */
	private async customer(customerId: string | null | undefined) {
		if (!customerId) return null;
		return this.crm.repository.getCustomer(customerId);
	}
}
