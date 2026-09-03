import type { Conversation } from "./conversation.ts";
import type { WebhookQueueMessage } from "./whatsapp/webhook.ts";

/**
 * Bindings and variables available to the Worker.
 * Secrets are provided with `wrangler secret put` and never live in source.
 */
export interface Env {
	// Bindings
	DB: D1Database;
	MEDIA: R2Bucket;
	WEBHOOK_QUEUE: Queue<WebhookQueueMessage>;
	CONVERSATION: DurableObjectNamespace<Conversation>;
	AI?: Ai;

	// Plain variables (wrangler.jsonc "vars")
	GRAPH_API_VERSION: string;
	REGION_NUMBERS: string;
	AUTO_REPLY_COOLDOWN_HOURS: string;
	TRACKING_URL: string;

	// Secrets
	WHATSAPP_ACCESS_TOKEN: string;
	WHATSAPP_APP_SECRET: string;
	WHATSAPP_VERIFY_TOKEN: string;
	INTERNAL_API_KEY: string;
}
