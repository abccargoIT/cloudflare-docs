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
	/** "true" serves the offline demonstration at /. See wrangler.jsonc. */
	SERVE_DEMO?: string;

	// Secrets
	WHATSAPP_ACCESS_TOKEN: string;
	WHATSAPP_APP_SECRET: string;
	WHATSAPP_VERIFY_TOKEN: string;
	INTERNAL_API_KEY: string;
	/**
	 * Shared secret echoed by Microsoft Graph on every change notification.
	 * The telephony endpoint is public, so this is what distinguishes Graph
	 * from anyone else who finds the URL. Optional until telephony is enabled;
	 * unset, the endpoint rejects everything.
	 */
	GRAPH_CLIENT_STATE?: string;
	/**
	 * Cloudflare Access, which authenticates the people using the console.
	 * ACCESS_TEAM_DOMAIN is the name in <team>.cloudflareaccess.com;
	 * ACCESS_AUD is the Application Audience tag of the Access application.
	 * With either unset, every console request is refused: a platform that
	 * cannot tell who is asking must not guess.
	 */
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
}
