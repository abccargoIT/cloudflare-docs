import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isWhatsAppPayload,
	splitWebhookPayload,
} from "../src/whatsapp/webhook.ts";

const payload = {
	object: "whatsapp_business_account",
	entry: [
		{
			id: "WABA1",
			changes: [
				{
					field: "messages",
					value: {
						messaging_product: "whatsapp",
						metadata: {
							display_phone_number: "971500000000",
							phone_number_id: "111",
						},
						contacts: [
							{ profile: { name: "Customer" }, wa_id: "971550000000" },
						],
						messages: [
							{
								from: "971550000000",
								id: "wamid.1",
								timestamp: "1756800000",
								type: "text",
								text: { body: "Hi" },
							},
						],
					},
				},
				{
					field: "messages",
					value: {
						messaging_product: "whatsapp",
						metadata: {
							display_phone_number: "971500000001",
							phone_number_id: "222",
						},
						statuses: [
							{
								id: "wamid.2",
								status: "delivered",
								timestamp: "1756800001",
								recipient_id: "971550000000",
							},
						],
					},
				},
				{ field: "messages", value: { messaging_product: "whatsapp" } },
			],
		},
	],
};

test("recognises WhatsApp payloads only", () => {
	assert.equal(isWhatsAppPayload(payload), true);
	assert.equal(isWhatsAppPayload({ object: "page", entry: [] }), false);
	assert.equal(isWhatsAppPayload(null), false);
	assert.equal(isWhatsAppPayload("x"), false);
});

test("splits one POST into one queue message per change with metadata", () => {
	const received = new Date("2026-09-02T06:30:00Z");
	const out = splitWebhookPayload(payload as never, received);
	assert.equal(out.length, 2);
	assert.equal(out[0]?.wabaId, "WABA1");
	assert.equal(out[0]?.value.metadata.phone_number_id, "111");
	assert.equal(out[1]?.value.statuses?.[0]?.status, "delivered");
	assert.equal(out[0]?.receivedAt, received.toISOString());
});
