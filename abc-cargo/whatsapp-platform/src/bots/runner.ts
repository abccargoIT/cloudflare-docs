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
import { runTurn } from "./runtime.ts";
import { BotService } from "./service.ts";
import type { BotFacts, BotSession } from "./types.ts";

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

export class BotRunner {
	private readonly bots: BotService;
	private readonly crm: CrmService;

	constructor(db: D1Database, crm: CrmService) {
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
		now?: Date;
	}): Promise<BotOutcome> {
		const now = input.now ?? new Date();
		const session = await this.bots.session(input.conversationId);

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
