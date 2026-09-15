import type { Env } from "../env.ts";
import { Repository } from "../db/repo.ts";
import { conversationIdFor } from "../conversation.ts";
import { CrmService } from "../crm/service.ts";
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

	for (const inbound of value.messages ?? []) {
		const conversationId = conversationIdFor(phoneNumberId, inbound.from);
		const stub = env.CONVERSATION.get(
			env.CONVERSATION.idFromName(conversationId),
		);
		await stub.handleInbound({
			phoneNumberId,
			contact: contactsByWaId.get(inbound.from),
			message: inbound,
			receivedAt: message.receivedAt,
		});

		// Classify the message and open whatever record it implies — a rate
		// enquiry becomes a lead before an agent is free, a claim becomes a
		// ticket with its clock already running. Storing the message in the
		// Durable Object is idempotent by WhatsApp message id, so a retry
		// after a failure here cannot duplicate the conversation entry.
		await crm.handleInboundMessage({
			waId: inbound.from,
			profileName: contactsByWaId.get(inbound.from)?.profile?.name,
			region,
			conversationId,
			text: inboundText(inbound),
			occurredAt: waTimestampToIso(inbound.timestamp, message.receivedAt),
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
		}
	}

	for (const error of value.errors ?? []) {
		console.error("webhook-level error from Meta", error);
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
