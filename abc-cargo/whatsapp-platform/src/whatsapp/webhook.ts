import type { WebhookPayload, WebhookValue } from "./types.ts";

/**
 * A single unit of work placed on the queue. One webhook POST from Meta can
 * carry many entries and changes; we split them so that a failure in one
 * conversation does not block or re-process the others on retry.
 */
export interface WebhookQueueMessage {
	wabaId: string;
	field: string;
	value: WebhookValue;
	receivedAt: string;
}

export function isWhatsAppPayload(input: unknown): input is WebhookPayload {
	if (typeof input !== "object" || input === null) return false;
	const candidate = input as Partial<WebhookPayload>;
	return (
		candidate.object === "whatsapp_business_account" &&
		Array.isArray(candidate.entry)
	);
}

export function splitWebhookPayload(
	payload: WebhookPayload,
	receivedAt: Date = new Date(),
): WebhookQueueMessage[] {
	const out: WebhookQueueMessage[] = [];
	for (const entry of payload.entry ?? []) {
		for (const change of entry.changes ?? []) {
			if (!change?.value?.metadata?.phone_number_id) continue;
			out.push({
				wabaId: entry.id,
				field: change.field,
				value: change.value,
				receivedAt: receivedAt.toISOString(),
			});
		}
	}
	return out;
}
