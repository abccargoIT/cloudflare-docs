import type { Env } from "./env.ts";
import {
	Repository,
	type ConversationStatus,
	type PresenceStatus,
} from "./db/repo.ts";
import { handleWebhookBatch } from "./queue/consumer.ts";
import { verifyMetaSignature, timingSafeEqual } from "./whatsapp/signature.ts";
import {
	isWhatsAppPayload,
	splitWebhookPayload,
	type WebhookQueueMessage,
} from "./whatsapp/webhook.ts";
import type { TemplateSendRequest } from "./whatsapp/types.ts";
import { findRegionById, parseRegionConfig } from "./regions.ts";
import { conversationIdFor, WindowClosedError } from "./conversation.ts";

export { Conversation } from "./conversation.ts";

const WEBHOOK_PATH = "/webhooks/whatsapp";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		try {
			if (url.pathname === "/health") {
				return json({ ok: true });
			}

			if (url.pathname === WEBHOOK_PATH && request.method === "GET") {
				return handleWebhookVerification(url, env);
			}

			if (url.pathname === WEBHOOK_PATH && request.method === "POST") {
				return await handleWebhookDelivery(request, env, ctx);
			}

			if (url.pathname.startsWith("/api/")) {
				const denied = requireInternalAuth(request, env);
				if (denied) return denied;
				return await handleApi(request, url, env);
			}

			return json({ error: "Not found" }, 404);
		} catch (error) {
			if (error instanceof WindowClosedError) {
				return json({ error: error.message }, 409);
			}
			console.error("unhandled error", {
				path: url.pathname,
				error: error instanceof Error ? error.message : String(error),
			});
			return json({ error: "Internal error" }, 500);
		}
	},

	async queue(batch, env): Promise<void> {
		await handleWebhookBatch(batch, env);
	},
} satisfies ExportedHandler<Env, WebhookQueueMessage>;

// ------------------------------------------------------------------ webhooks

/**
 * Meta calls GET with hub.mode=subscribe when the callback URL is saved in
 * the App dashboard. We must echo hub.challenge if the verify token matches.
 */
function handleWebhookVerification(url: URL, env: Env): Response {
	const mode = url.searchParams.get("hub.mode");
	const token = url.searchParams.get("hub.verify_token") ?? "";
	const challenge = url.searchParams.get("hub.challenge") ?? "";
	if (
		mode === "subscribe" &&
		env.WHATSAPP_VERIFY_TOKEN &&
		timingSafeEqual(token, env.WHATSAPP_VERIFY_TOKEN)
	) {
		return new Response(challenge, {
			status: 200,
			headers: { "Content-Type": "text/plain" },
		});
	}
	return json({ error: "Verification failed" }, 403);
}

/**
 * Meta expects a fast 200. We verify the signature, split the payload and
 * hand the work to the queue; processing happens in the consumer.
 */
async function handleWebhookDelivery(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const rawBody = await request.text();
	const valid = await verifyMetaSignature(
		rawBody,
		request.headers.get("X-Hub-Signature-256"),
		env.WHATSAPP_APP_SECRET,
	);
	if (!valid) {
		return json({ error: "Invalid signature" }, 401);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return json({ error: "Invalid JSON" }, 400);
	}
	if (!isWhatsAppPayload(payload)) {
		// Not for us; acknowledge so Meta does not retry.
		return new Response("EVENT_RECEIVED", { status: 200 });
	}

	const messages = splitWebhookPayload(payload);
	if (messages.length > 0) {
		// Queues accept up to 100 messages per sendBatch call.
		const chunks: WebhookQueueMessage[][] = [];
		for (let i = 0; i < messages.length; i += 100) {
			chunks.push(messages.slice(i, i + 100));
		}
		ctx.waitUntil(
			Promise.all(
				chunks.map((chunk) =>
					env.WEBHOOK_QUEUE.sendBatch(chunk.map((body) => ({ body }))),
				),
			),
		);
	}
	return new Response("EVENT_RECEIVED", { status: 200 });
}

// ----------------------------------------------------------------- internal

/**
 * The /api/* routes are for the agent console and internal systems only.
 * Put Cloudflare Access in front of this hostname as well; the bearer key is
 * a second factor, not the only control.
 */
function requireInternalAuth(request: Request, env: Env): Response | null {
	const header = request.headers.get("Authorization") ?? "";
	const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
	if (
		!env.INTERNAL_API_KEY ||
		!presented ||
		!timingSafeEqual(presented, env.INTERNAL_API_KEY)
	) {
		return json({ error: "Unauthorized" }, 401);
	}
	return null;
}

async function handleApi(
	request: Request,
	url: URL,
	env: Env,
): Promise<Response> {
	const repo = new Repository(env.DB);
	const segments = url.pathname.split("/").filter(Boolean); // ["api", ...]
	const [, resource, rawId, action] = segments;
	const id = rawId ? decodeURIComponent(rawId) : undefined;

	// GET /api/conversations?region=&status=&agent=&limit=
	if (resource === "conversations" && !id && request.method === "GET") {
		const rows = await repo.listConversations({
			regionId: url.searchParams.get("region") ?? undefined,
			status:
				(url.searchParams.get("status") as ConversationStatus) ?? undefined,
			agentId: url.searchParams.get("agent") ?? undefined,
			limit: Number(url.searchParams.get("limit") ?? "50"),
		});
		return json({ conversations: rows });
	}

	// GET /api/conversations/:id
	if (
		resource === "conversations" &&
		id &&
		!action &&
		request.method === "GET"
	) {
		const conversation = await repo.getConversation(id);
		if (!conversation) return json({ error: "Not found" }, 404);
		const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(id));
		const [state, messages] = await Promise.all([
			stub.getState(),
			repo.listMessages(id, Number(url.searchParams.get("limit") ?? "50")),
		]);
		return json({ conversation, state, messages });
	}

	// POST /api/conversations/:id/reply   { agentId, text }
	if (
		resource === "conversations" &&
		id &&
		action === "reply" &&
		request.method === "POST"
	) {
		const body = await readJson<{ agentId?: string; text?: string }>(request);
		if (!body?.agentId || !body.text?.trim()) {
			return json({ error: "agentId and text are required" }, 400);
		}
		const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(id));
		const result = await stub.reply({
			agentId: body.agentId,
			text: body.text.trim(),
		});
		return json(result);
	}

	// POST /api/conversations/:id/assign   { agentId | null, actor }
	if (
		resource === "conversations" &&
		id &&
		action === "assign" &&
		request.method === "POST"
	) {
		const body = await readJson<{ agentId?: string | null; actor?: string }>(
			request,
		);
		if (!body || body.agentId === undefined) {
			return json({ error: "agentId is required (null to unassign)" }, 400);
		}
		const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(id));
		await stub.assign(body.agentId, body.actor ?? "api");
		return json({ ok: true });
	}

	// POST /api/conversations/:id/status   { status, actor }
	if (
		resource === "conversations" &&
		id &&
		action === "status" &&
		request.method === "POST"
	) {
		const body = await readJson<{
			status?: ConversationStatus;
			actor?: string;
		}>(request);
		if (
			!body?.status ||
			!["open", "pending", "resolved"].includes(body.status)
		) {
			return json({ error: "status must be open, pending or resolved" }, 400);
		}
		const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(id));
		await stub.setStatus(body.status, body.actor ?? "api");
		return json({ ok: true });
	}

	// POST /api/notifications/template
	//   { region, to, requestedBy, template: { name, languageCode, components? } }
	if (
		resource === "notifications" &&
		id === "template" &&
		request.method === "POST"
	) {
		const body = await readJson<{
			region?: string;
			to?: string;
			requestedBy?: string;
			template?: TemplateSendRequest;
		}>(request);
		if (
			!body?.region ||
			!body.to ||
			!body.template?.name ||
			!body.template.languageCode
		) {
			return json(
				{ error: "region, to and template.name/languageCode are required" },
				400,
			);
		}
		const region = findRegionById(
			parseRegionConfig(env.REGION_NUMBERS),
			body.region,
		);
		if (!region) return json({ error: "Unknown region" }, 400);
		const to = normaliseWaId(body.to);
		const convId = conversationIdFor(region.phoneNumberId, to);
		const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(convId));
		const result = await stub.sendTemplate({
			init: { phoneNumberId: region.phoneNumberId, waId: to },
			requestedBy: body.requestedBy ?? "api",
			template: body.template,
		});
		return json({ conversationId: convId, ...result });
	}

	// POST /api/agents/:id/presence   { status }
	if (
		resource === "agents" &&
		id &&
		action === "presence" &&
		request.method === "POST"
	) {
		const body = await readJson<{ status?: PresenceStatus }>(request);
		if (!body?.status || !["online", "away", "offline"].includes(body.status)) {
			return json({ error: "status must be online, away or offline" }, 400);
		}
		await repo.setAgentPresence(id, body.status, new Date().toISOString());
		return json({ ok: true });
	}

	return json({ error: "Not found" }, 404);
}

// ------------------------------------------------------------------ helpers

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

async function readJson<T>(request: Request): Promise<T | null> {
	try {
		return (await request.json()) as T;
	} catch {
		return null;
	}
}

/** WhatsApp IDs are international numbers without "+" or separators. */
export function normaliseWaId(input: string): string {
	return input.replace(/[^\d]/g, "");
}
