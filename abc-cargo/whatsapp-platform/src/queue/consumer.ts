import type { Env } from "../env.ts";
import { Repository } from "../db/repo.ts";
import { conversationIdFor } from "../conversation.ts";
import { CrmService } from "../crm/service.ts";
import { BotRunner } from "../bots/runner.ts";
import { BroadcastService } from "../broadcasts/service.ts";
import { MILESTONE_LABELS } from "../crm/types.ts";
import { CsatStore } from "../crm/csat-store.ts";
import {
	parseSurveyReply,
	surveyStillOpen,
	type SurveyResponse,
} from "../crm/csat.ts";
import type { WebhookQueueMessage } from "../whatsapp/webhook.ts";
import {
	findRegionByPhoneNumberId,
	parseRegionConfig,
	type RegionConfig,
} from "../regions.ts";

/**
 * Queue consumer. Each queue message is one webhook "change" (see
 * splitWebhookPayload). Inbound customer messages are routed to the
 * per-thread Durable Object; delivery statuses update D1 directly.
 */
export async function handleWebhookBatch(
	batch: MessageBatch<WebhookQueueMessage>,
	env: Env,
): Promise<void> {
	const regions = parseRegionConfig(env.REGION_NUMBERS);
	for (const msg of batch.messages) {
		try {
			await processWebhookMessage(msg.body, env, regions);
			msg.ack();
		} catch (error) {
			console.error("webhook processing failed", {
				attempt: msg.attempts,
				phoneNumberId: msg.body.value?.metadata?.phone_number_id,
				error: error instanceof Error ? error.message : String(error),
			});
			// Exponential backoff: 10s, 20s, 40s, ... capped at 10 minutes.
			msg.retry({ delaySeconds: Math.min(600, 10 * 2 ** (msg.attempts - 1)) });
		}
	}
}

export async function processWebhookMessage(
	message: WebhookQueueMessage,
	env: Env,
	regions: RegionConfig[],
): Promise<void> {
	if (message.field !== "messages") {
		// Other subscribed fields (account updates, template status, etc.)
		console.info("ignoring webhook field", message.field);
		return;
	}

	const { value } = message;
	const phoneNumberId = value.metadata.phone_number_id;
	const region = findRegionByPhoneNumberId(regions, phoneNumberId);
	if (!region) {
		// Acknowledge rather than retry: the number is simply not configured.
		console.warn("webhook for unconfigured phone number id", phoneNumberId);
		return;
	}

	const contactsByWaId = new Map(
		(value.contacts ?? []).map((c) => [c.wa_id, c] as const),
	);

	const crm = new CrmService(env.DB);
	const bots = new BotRunner(env.DB, crm);
	const broadcasts = new BroadcastService(env.DB);
	const surveys = new CsatStore(env.DB);

	// Asked once per batch rather than once per message. With no published flow
	// for this region the rest of this function behaves exactly as it did
	// before the bot existed: the automated reply is sent from the Durable
	// Object and nothing else happens.
	const botFronted = await bots.hasPublishedFlow(region.id);

	for (const inbound of value.messages ?? []) {
		const conversationId = conversationIdFor(phoneNumberId, inbound.from);
		const stub = env.CONVERSATION.get(
			env.CONVERSATION.idFromName(conversationId),
		);

		// An answer to a satisfaction survey is decided before anything else
		// reads the message. Read by the bot, "5" is menu option five; read
		// by the out-of-hours reply, a customer who has just rated us is told
		// the office is closed. Neither should happen.
		const surveyAnswer = await answerToOpenSurvey(
			surveys,
			conversationId,
			inbound,
		);

		const stored = await stub.handleInbound({
			phoneNumberId,
			contact: contactsByWaId.get(inbound.from),
			message: inbound,
			receivedAt: message.receivedAt,
			// The bot is going to answer, so the customer should not also get
			// the automated reply in the same moment. Nor is a survey answer
			// something to reply to automatically.
			autoReply: !botFronted && !surveyAnswer,
			reopen: !surveyAnswer,
		});

		if (surveyAnswer) {
			// Only the first answer counts; a duplicate webhook or a second
			// score finds the survey already answered and changes nothing.
			if (!stored.duplicate) {
				await surveys.recordResponse({
					conversationId,
					score: surveyAnswer.score,
					comment: surveyAnswer.comment,
					respondedAt: waTimestampToIso(inbound.timestamp, message.receivedAt),
				});
			}
			// The message is in the conversation for anyone reading it. It is
			// not classified — a score is not an enquiry — and the bot does
			// not see it.
			continue;
		}

		// Classify the message and open whatever record it implies — a rate
		// enquiry becomes a lead before an agent is free, a claim becomes a
		// ticket with its clock already running. Storing the message in the
		// Durable Object is idempotent by WhatsApp message id, so a retry
		// after a failure here cannot duplicate the conversation entry.
		const handling = await crm.handleInboundMessage({
			waId: inbound.from,
			profileName: contactsByWaId.get(inbound.from)?.profile?.name,
			region,
			conversationId,
			text: inboundText(inbound),
			occurredAt: waTimestampToIso(inbound.timestamp, message.receivedAt),
		});

		// An inbound message within three days of a broadcast send on this
		// conversation counts as a reply to it. Attributed here rather than in
		// the CRM because it is a fact about the campaign, not about the
		// customer, and a duplicate webhook must not count twice — which the
		// replied_at guard in the service handles.
		if (!stored.duplicate) {
			await broadcasts.recordReply({ conversationId });
		}

		// A webhook Meta has already delivered must not advance the flow. The
		// customer would be answered twice and the session would move two steps
		// on one message.
		if (!botFronted || stored.duplicate) continue;

		await bots.handleInbound({
			conversationId,
			region,
			customerId: handling.customer.id,
			text: inboundText(inbound),
			facts: {
				references: handling.intent.references,
				contactName: handling.customer.display_name,
				booking: handling.booking
					? {
							ref: handling.booking.ref,
							// The label, not the stored identifier: "in_transit" is
							// correct in a column and wrong in a WhatsApp message.
							milestone: MILESTONE_LABELS[handling.booking.milestone],
							updatedAt: handling.booking.milestone_at,
						}
					: null,
			},
			conversation: stub,
			reopened: stored.reopened,
		});
	}

	if (value.statuses?.length) {
		const repo = new Repository(env.DB);
		for (const status of value.statuses) {
			const firstError = status.errors?.[0];
			await repo.updateMessageStatus(
				status.id,
				status.status,
				firstError?.code,
				firstError?.title,
			);
			// A broadcast recipient tracks the same status, so "delivered" and
			// "read" on a campaign are the real figures rather than an
			// estimate. Moves forward only: Meta does not promise the order
			// these arrive in, and a late "delivered" after a "read" must not
			// make a campaign's read count fall.
			if (status.status === "delivered" || status.status === "read") {
				await broadcasts.recordDeliveryStatus({
					waMessageId: status.id,
					status: status.status,
				});
			}
		}
	}

	for (const error of value.errors ?? []) {
		console.error("webhook-level error from Meta", error);
	}
}

/**
 * The customer's score, when this message answers a survey still open on the
 * conversation. Null for everything else, including a reply that does not
 * read as a score: "actually I have another question" starts a conversation
 * and is handled as one.
 */
async function answerToOpenSurvey(
	surveys: CsatStore,
	conversationId: string,
	message: {
		text?: { body: string };
		button?: { payload: string; text: string };
		interactive?: { button_reply?: { id: string; title: string } };
	},
	now: Date = new Date(),
): Promise<SurveyResponse | null> {
	const raw = message.text?.body ?? message.button?.text ?? "";
	const payload =
		message.interactive?.button_reply?.id ?? message.button?.payload ?? null;
	// Cheap test first: most messages are not a number or a csat: button, and
	// those need no database read at all.
	if (!parseSurveyReply(raw, payload)) return null;
	try {
		const survey = await surveys.openSurvey(conversationId);
		if (!survey || !surveyStillOpen(survey.sent_at, now)) return null;
		return parseSurveyReply(raw, payload);
	} catch (error) {
		// A survey table that cannot be read must not stop the customer's
		// message being handled. It falls through as an ordinary message.
		console.error("could not check for an open survey", {
			conversationId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * The text a classifier should read. Interactive replies carry the customer's
 * choice in their own fields, and a button press is as much a statement of
 * intent as a typed sentence.
 */
function inboundText(message: {
	text?: { body: string };
	button?: { text: string };
	interactive?: {
		button_reply?: { title: string };
		list_reply?: { title: string };
	};
	caption?: string;
}): string | undefined {
	return (
		message.text?.body ??
		message.interactive?.button_reply?.title ??
		message.interactive?.list_reply?.title ??
		message.button?.text ??
		message.caption
	);
}

/** WhatsApp sends Unix seconds as a string; fall back to our receive time. */
function waTimestampToIso(
	timestamp: string | undefined,
	fallback: string,
): string {
	const seconds = Number(timestamp);
	if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
	return new Date(seconds * 1000).toISOString();
}
