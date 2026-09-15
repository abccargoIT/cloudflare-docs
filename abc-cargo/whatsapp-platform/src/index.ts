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
import { CrmService } from "./crm/service.ts";
import { InvalidTransitionError } from "./crm/lifecycle.ts";
import {
	LEAD_STAGES,
	MILESTONES,
	QUOTATION_STATUSES,
	TICKET_PRIORITIES,
	TICKET_TYPES,
	TICKET_STATUSES,
	TRANSPORT_MODES,
} from "./crm/types.ts";

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
			if (error instanceof InvalidTransitionError) {
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

	const operations = await handleOperationsApi(request, url, env, segments);
	if (operations) return operations;

	return json({ error: "Not found" }, 404);
}

/**
 * Routes for the commercial and service side: customers, leads, quotations,
 * bookings, tickets and calls. Returns null when the path is not one of
 * these, so the caller can fall through to its own 404.
 */
async function handleOperationsApi(
	request: Request,
	url: URL,
	env: Env,
	segments: string[],
): Promise<Response | null> {
	const [, resource, rawId, action] = segments;
	const id = rawId ? decodeURIComponent(rawId) : undefined;
	const crm = new CrmService(env.DB);
	const repo = crm.repository;
	const region = url.searchParams.get("region") ?? undefined;
	const limit = Number(url.searchParams.get("limit") ?? "50");

	/* ------------------------------------------------------------ customers */

	if (resource === "customers" && !id && request.method === "GET") {
		return json({
			customers: await repo.listCustomers({ regionId: region, limit }),
		});
	}

	// GET /api/customers/:id — everything Customer 360 shows, in one call.
	if (resource === "customers" && id && !action && request.method === "GET") {
		const view = await crm.customerView(
			id,
			Number(url.searchParams.get("activities") ?? "100"),
		);
		if (!view) return json({ error: "Not found" }, 404);
		return json(view);
	}

	/* ---------------------------------------------------------------- leads */

	if (resource === "leads" && !id && request.method === "GET") {
		const stage = url.searchParams.get("stage");
		return json({
			leads: await repo.listLeads({
				regionId: region,
				customerId: url.searchParams.get("customer") ?? undefined,
				stage: isOneOf(stage, LEAD_STAGES),
				openOnly: url.searchParams.get("open") === "true",
				limit,
			}),
		});
	}

	// POST /api/leads/:ref/stage   { stage, actor, lostReason? }
	if (
		resource === "leads" &&
		id &&
		action === "stage" &&
		request.method === "POST"
	) {
		const body = await readJson<{
			stage?: string;
			actor?: string;
			lostReason?: string;
		}>(request);
		const stage = isOneOf(body?.stage, LEAD_STAGES);
		if (!stage) {
			return json(
				{ error: `stage must be one of ${LEAD_STAGES.join(", ")}` },
				400,
			);
		}
		const lead = await crm.advanceLead(
			id,
			stage,
			body?.actor ?? "api",
			body?.lostReason,
		);
		return json({ lead });
	}

	/* ----------------------------------------------------------- quotations */

	if (resource === "quotations" && !id && request.method === "GET") {
		const status = url.searchParams.get("status");
		return json({
			quotations: await repo.listQuotations({
				regionId: region,
				customerId: url.searchParams.get("customer") ?? undefined,
				status: isOneOf(status, QUOTATION_STATUSES),
				limit,
			}),
		});
	}

	// POST /api/quotations
	if (resource === "quotations" && !id && request.method === "POST") {
		const body = await readJson<{
			leadRef?: string;
			customerId?: string;
			region?: string;
			origin?: string;
			destination?: string;
			mode?: string;
			chargeableKg?: number;
			totalAmount?: number;
			currency?: string;
			validUntil?: string;
			actor?: string;
		}>(request);
		const mode = isOneOf(body?.mode, TRANSPORT_MODES);
		if (
			!body?.customerId ||
			!body.region ||
			!body.origin ||
			!body.destination ||
			!mode ||
			typeof body.totalAmount !== "number" ||
			!body.currency
		) {
			return json(
				{
					error:
						"customerId, region, origin, destination, mode, totalAmount and currency are required",
				},
				400,
			);
		}
		const quotation = await crm.createQuotation({
			leadIdOrRef: body.leadRef,
			customerId: body.customerId,
			regionId: body.region,
			origin: body.origin,
			destination: body.destination,
			mode,
			chargeableKg: body.chargeableKg ?? null,
			totalAmount: body.totalAmount,
			currency: body.currency,
			validUntil: body.validUntil ?? null,
			actor: body.actor ?? "api",
		});
		return json({ quotation }, 201);
	}

	// POST /api/quotations/:ref/status   { status, actor, sentChannel? }
	if (
		resource === "quotations" &&
		id &&
		action === "status" &&
		request.method === "POST"
	) {
		const body = await readJson<{
			status?: string;
			actor?: string;
			sentChannel?: string;
		}>(request);
		const status = isOneOf(body?.status, QUOTATION_STATUSES);
		if (!status) {
			return json(
				{ error: `status must be one of ${QUOTATION_STATUSES.join(", ")}` },
				400,
			);
		}
		const quotation = await crm.moveQuotation({
			quotationIdOrRef: id,
			to: status,
			actor: body?.actor ?? "api",
			sentChannel: body?.sentChannel,
		});
		return json({ quotation });
	}

	// POST /api/quotations/:ref/booking   { pieces?, weightKg?, actor? }
	if (
		resource === "quotations" &&
		id &&
		action === "booking" &&
		request.method === "POST"
	) {
		const body = await readJson<{
			pieces?: number;
			weightKg?: number;
			actor?: string;
		}>(request);
		const booking = await crm.createBookingFromQuotation({
			quotationIdOrRef: id,
			pieces: body?.pieces ?? null,
			weightKg: body?.weightKg ?? null,
			actor: body?.actor ?? "api",
		});
		return json({ booking }, 201);
	}

	/* ------------------------------------------------------------- bookings */

	if (resource === "bookings" && !id && request.method === "GET") {
		const milestone = url.searchParams.get("milestone");
		return json({
			bookings: await repo.listBookings({
				regionId: region,
				customerId: url.searchParams.get("customer") ?? undefined,
				milestone: isOneOf(milestone, MILESTONES),
				undelivered: url.searchParams.get("active") === "true",
				limit,
			}),
		});
	}

	if (resource === "bookings" && id && !action && request.method === "GET") {
		const booking = await repo.getBooking(id);
		if (!booking) return json({ error: "Not found" }, 404);
		return json({ booking });
	}

	// POST /api/bookings/:ref/milestone   { milestone, occurredAt?, source?, actor? }
	if (
		resource === "bookings" &&
		id &&
		action === "milestone" &&
		request.method === "POST"
	) {
		const body = await readJson<{
			milestone?: string;
			occurredAt?: string;
			source?: string;
			actor?: string;
		}>(request);
		const milestone = isOneOf(body?.milestone, MILESTONES);
		if (!milestone) {
			return json(
				{ error: `milestone must be one of ${MILESTONES.join(", ")}` },
				400,
			);
		}
		const result = await crm.recordMilestone({
			bookingIdOrRef: id,
			milestone,
			occurredAt: body?.occurredAt,
			source: body?.source,
			actor: body?.actor ?? "api",
		});
		// The proactive message is returned rather than sent here: the caller
		// decides, and a retry of this request cannot send it twice.
		return json(result);
	}

	/* -------------------------------------------------------------- tickets */

	if (resource === "tickets" && !id && request.method === "GET") {
		const status = url.searchParams.get("status");
		const type = url.searchParams.get("type");
		return json({
			tickets: await repo.listTickets({
				regionId: region,
				customerId: url.searchParams.get("customer") ?? undefined,
				status: isOneOf(status, TICKET_STATUSES),
				type: isOneOf(type, TICKET_TYPES),
				openOnly: url.searchParams.get("open") === "true",
				limit,
			}),
		});
	}

	// POST /api/tickets   { customerId, region, type, subject, priority?, bookingId? }
	if (resource === "tickets" && !id && request.method === "POST") {
		const body = await readJson<{
			customerId?: string;
			region?: string;
			type?: string;
			subject?: string;
			priority?: string;
			bookingId?: string;
			conversationId?: string;
		}>(request);
		const type = isOneOf(body?.type, TICKET_TYPES);
		const priority = isOneOf(body?.priority, TICKET_PRIORITIES) ?? "normal";
		if (!body?.customerId || !body.region || !type || !body.subject?.trim()) {
			return json(
				{ error: "customerId, region, type and subject are required" },
				400,
			);
		}
		const regionConfig = findRegionById(
			parseRegionConfig(env.REGION_NUMBERS),
			body.region,
		);
		if (!regionConfig) return json({ error: "Unknown region" }, 400);
		const customer = await repo.getCustomer(body.customerId);
		if (!customer) return json({ error: "Unknown customer" }, 400);

		const ticket = await crm.openTicketIfNoneOpen({
			customer,
			region: regionConfig,
			type,
			subject: body.subject.trim(),
			priority,
			bookingId: body.bookingId ?? null,
			conversationId: body.conversationId ?? null,
		});
		return json({ ticket }, 201);
	}

	// POST /api/tickets/:ref/resolve   { actor }
	if (
		resource === "tickets" &&
		id &&
		action === "resolve" &&
		request.method === "POST"
	) {
		const body = await readJson<{ actor?: string }>(request);
		const ticket = await crm.resolveTicket(id, body?.actor ?? "api");
		return json({ ticket });
	}

	/* ---------------------------------------------------------------- calls */

	if (resource === "calls" && !id && request.method === "GET") {
		return json({
			calls: await repo.listCalls({
				regionId: region,
				customerId: url.searchParams.get("customer") ?? undefined,
				limit,
			}),
		});
	}

	// POST /api/calls
	if (resource === "calls" && !id && request.method === "POST") {
		const body = await readJson<{
			customerId?: string;
			region?: string;
			direction?: string;
			agentId?: string;
			startedAt?: string;
			durationSeconds?: number;
			outcome?: string;
			linkedType?: string;
			linkedId?: string;
		}>(request);
		if (
			!body?.customerId ||
			!body.region ||
			(body.direction !== "in" && body.direction !== "out")
		) {
			return json(
				{ error: "customerId, region and direction (in|out) are required" },
				400,
			);
		}
		await crm.recordCall({
			customerId: body.customerId,
			regionId: body.region,
			direction: body.direction,
			agentId: body.agentId ?? null,
			startedAt: body.startedAt ?? new Date().toISOString(),
			durationSeconds: body.durationSeconds ?? 0,
			outcome: body.outcome,
			linkedType: body.linkedType,
			linkedId: body.linkedId,
		});
		return json({ ok: true }, 201);
	}

	/* ------------------------------------------------------- stalled sweep */

	// POST /api/operations/sweep-stalled — opens a ticket for each shipment
	// that has gone quiet. Safe to call repeatedly; it will not duplicate.
	if (
		resource === "operations" &&
		id === "sweep-stalled" &&
		request.method === "POST"
	) {
		const regions = parseRegionConfig(env.REGION_NUMBERS);
		const opened = await crm.sweepStalledBookings(regions);
		return json({ opened: opened.length, tickets: opened });
	}

	return null;
}

/** Narrows a query or body value to one of a literal union. */
function isOneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
): T | undefined {
	return typeof value === "string" &&
		(allowed as readonly string[]).includes(value)
		? (value as T)
		: undefined;
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
