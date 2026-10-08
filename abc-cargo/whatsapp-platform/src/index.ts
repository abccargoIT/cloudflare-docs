import type { Env } from "./env.ts";
import {
	Repository,
	type ConversationStatus,
	type PresenceStatus,
} from "./db/repo.ts";
import { handleWebhookBatch } from "./queue/consumer.ts";
import { verifyMetaSignature, timingSafeEqual } from "./whatsapp/signature.ts";
import {
	AccessRejected,
	accessTokenFrom,
	verifyAccessToken,
} from "./auth/access.ts";
import { Directory } from "./auth/directory.ts";
import {
	canAssignConversation,
	canReadConversation,
	canAdminister,
	canReadRegionalRecord,
	canReplyToConversation,
	canViewReports,
	reportableRegions,
	resolveRegionFilter,
	type Caller,
} from "./auth/policy.ts";
import {
	NotificationRejected,
	parseNotificationBatch,
	validationTokenFrom,
} from "./telephony/graph.ts";
import {
	isWhatsAppPayload,
	splitWebhookPayload,
	type WebhookQueueMessage,
} from "./whatsapp/webhook.ts";
import type { TemplateSendRequest } from "./whatsapp/types.ts";
import { findRegionById, parseRegionConfig } from "./regions.ts";
import { conversationIdFor, WindowClosedError } from "./conversation.ts";
import { CrmService } from "./crm/service.ts";
import { Reports, parseWindow } from "./crm/reports.ts";
import { Contacts, isCustomerStage } from "./crm/contacts.ts";
import { ChatService, isRefKind } from "./chat/service.ts";
import {
	canPostToThread,
	canReadThread,
	canStartDirect,
} from "./chat/policy.ts";
import { CUSTOMER_STAGES } from "./crm/customer-lifecycle.ts";
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

// Bundled as text by the "rules" entry in wrangler.jsonc. It is the built
// demonstration page, which already contains the platform's own compiled
// decision code and no credentials of any kind.
import demoPage from "../demo/app.html";

const WEBHOOK_PATH = "/webhooks/whatsapp";
const TELEPHONY_PATH = "/webhooks/teams";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		try {
			if (
				request.method === "GET" &&
				(url.pathname === "/" || url.pathname === "/demo") &&
				env.SERVE_DEMO === "true"
			) {
				return servedemo();
			}

			if (url.pathname === "/health") {
				return json({ ok: true });
			}

			if (url.pathname === WEBHOOK_PATH && request.method === "GET") {
				return handleWebhookVerification(url, env);
			}

			if (url.pathname === WEBHOOK_PATH && request.method === "POST") {
				return await handleWebhookDelivery(request, env, ctx);
			}

			if (url.pathname === TELEPHONY_PATH && request.method === "POST") {
				return await handleTelephonyNotification(request, url, env);
			}

			if (url.pathname.startsWith("/api/")) {
				const resolved = await resolveCaller(request, env, url);
				if ("response" in resolved) return resolved.response;
				return await handleApi(request, url, env, resolved.caller);
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
/**
 * Microsoft Graph change notifications for Teams calls.
 *
 * Graph proves it owns a new subscription by POSTing a `validationToken` which
 * must come back as plain text within ten seconds, so that case is answered
 * before anything else happens.
 *
 * Afterwards the only thing separating a stranger's POST from a write to a
 * customer's history is the `clientState` secret agreed when the subscription
 * was created. A batch is accepted or rejected whole: one valid notification
 * does not vouch for a forged one beside it.
 *
 * Graph expects a fast acknowledgement and retries without one, so this
 * returns immediately rather than calling back into Graph inline — the same
 * shape as the WhatsApp receiver.
 */
async function handleTelephonyNotification(
	request: Request,
	url: URL,
	env: Env,
): Promise<Response> {
	const token = validationTokenFrom(url);
	if (token) {
		return new Response(token, {
			status: 200,
			headers: { "content-type": "text/plain" },
		});
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: "Invalid JSON" }, 400);
	}

	let notifications;
	try {
		notifications = parseNotificationBatch(body, env.GRAPH_CLIENT_STATE ?? "");
	} catch (error) {
		if (error instanceof NotificationRejected) {
			// Deliberately terse: an attacker learns nothing about why.
			return json({ error: "Rejected" }, 401);
		}
		throw error;
	}

	// TODO(telephony): enqueue for the consumer, which fetches the call record
	// or transcript from Graph and writes it to the customer timeline. Held
	// back until the tenant permissions in
	// docs/integrations-crm-and-telephony.md are granted, so nothing
	// half-finished can reach a live tenant.
	return json({ accepted: notifications.length }, 202);
}

/**
 * Serves the offline demonstration so the hostname is usable for testing
 * before any Meta credential exists.
 *
 * The page is self-contained: it holds the platform's own compiled rules and
 * invented sample data, talks to nothing, and stores what it does in the
 * viewer's own browser. Nothing here reaches a customer.
 *
 * It is, however, world-readable to anyone who knows the hostname. Put
 * Cloudflare Access in front of it before sharing the link outside ABC Cargo,
 * and set SERVE_DEMO to "false" before the first live number is cut over.
 */
function servedemo(): Response {
	return new Response(demoPage, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			// Nothing here is cacheable for long: a rebuilt demonstration should
			// reach a reviewer on the next refresh, not after an hour.
			"cache-control": "no-cache",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
			// The page loads nothing from anywhere. Say so, so a stray tag added
			// later fails loudly instead of quietly fetching.
			"content-security-policy":
				"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
			"x-robots-tag": "noindex, nofollow",
		},
	});
}

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
 * Establishes who is making a console request.
 *
 * Two kinds of caller, and they are deliberately not the same thing.
 *
 * A **person** arrives through Cloudflare Access, and is believed only after
 * their assertion's signature has been verified against the account's own
 * keys. Being signed in is not enough on its own: they also have to be a
 * known, active user here, in at least one team. Access knows who someone is;
 * only this platform knows what they may see.
 *
 * A **service** presents the shared key. It is for the shipment system and
 * scheduled sweeps, carries no region and no person, and cannot administer.
 *
 * Every outcome is written to the access log, denials included.
 */
async function resolveCaller(
	request: Request,
	env: Env,
	url: URL,
): Promise<{ caller: Caller } | { response: Response }> {
	const directory = new Directory(env.DB);
	const log = (
		outcome: "granted" | "denied",
		reason: string,
		who: { userId?: string | null; email?: string | null } = {},
	) =>
		directory
			.record({
				...who,
				method: request.method,
				path: url.pathname,
				outcome,
				reason,
			})
			// A logging failure must not become an authorisation failure, but it
			// must not pass silently either.
			.catch((error) => console.error("access log write failed", error));

	// Machine callers first: a service key is unambiguous and cheap to check.
	const header = request.headers.get("Authorization") ?? "";
	const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
	if (presented) {
		if (
			env.INTERNAL_API_KEY &&
			timingSafeEqual(presented, env.INTERNAL_API_KEY)
		) {
			await log("granted", "ok", { email: "service" });
			return { caller: { kind: "service", name: "internal" } };
		}
		await log("denied", "no_identity");
		return { response: json({ error: "Unauthorized" }, 401) };
	}

	const token = accessTokenFrom(request);
	if (!token) {
		await log("denied", "no_identity");
		return { response: json({ error: "Unauthorized" }, 401) };
	}

	let email: string;
	try {
		const identity = await verifyAccessToken(token, {
			teamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
			audience: env.ACCESS_AUD ?? "",
		});
		email = identity.email;
	} catch (error) {
		const code = error instanceof AccessRejected ? error.code : "invalid";
		await log("denied", code);
		return { response: json({ error: "Unauthorized" }, 401) };
	}

	const result = await directory.callerForEmail(email);
	if (!result.ok) {
		await log("denied", result.reason, { email });
		// Deliberately the same body as every other refusal: a signed-in
		// stranger learns whether they exist here from nothing but the log.
		return { response: json({ error: "Forbidden" }, 403) };
	}

	await log("granted", "ok", { userId: result.caller.id, email });
	return { caller: result.caller };
}

/** The refusal a policy decision turns into. */
function refuse(reason: string): Response {
	return json({ error: "Forbidden", reason }, 403);
}

async function handleApi(
	request: Request,
	url: URL,
	env: Env,
	caller: Caller,
): Promise<Response> {
	const repo = new Repository(env.DB);
	const segments = url.pathname.split("/").filter(Boolean); // ["api", ...]
	const [, resource, rawId, action] = segments;
	const id = rawId ? decodeURIComponent(rawId) : undefined;

	// GET /api/conversations?region=&status=&agent=&limit=
	if (resource === "conversations" && !id && request.method === "GET") {
		// The caller is free to ask for any region. What comes back is the
		// intersection with the regions they may actually see: ask for
		// everything and you get your own, ask for someone else's and you get
		// nothing.
		const regions = resolveRegionFilter(caller, url.searchParams.get("region"));
		if (regions !== null && regions.length === 0) {
			return json({ conversations: [] });
		}

		const status =
			(url.searchParams.get("status") as ConversationStatus) ?? undefined;
		const limit = Number(url.searchParams.get("limit") ?? "50");
		const agentId = url.searchParams.get("agent") ?? undefined;

		const rows =
			regions === null
				? await repo.listConversations({
						regionId: undefined,
						status,
						agentId,
						limit,
					})
				: (
						await Promise.all(
							regions.map((regionId) =>
								repo.listConversations({ regionId, status, agentId, limit }),
							),
						)
					).flat();

		// An agent sees their own conversations and the unclaimed queue, never
		// another agent's open case. The filter is applied here rather than in
		// SQL so one rule governs both the list and the fetch.
		const visible = rows.filter(
			(row) =>
				canReadConversation(caller, {
					id: row.id,
					regionId: row.region_id,
					assignedAgentId: row.assigned_agent_id,
				}).allowed,
		);
		return json({ conversations: visible.slice(0, limit) });
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
		const allowed = canReadConversation(caller, {
			id: conversation.id,
			regionId: conversation.region_id,
			assignedAgentId: conversation.assigned_agent_id,
		});
		if (!allowed.allowed) return refuse(allowed.reason);
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
		const conversation = await repo.getConversation(id);
		if (!conversation) return json({ error: "Not found" }, 404);
		// Replying is stricter than reading: an unclaimed conversation can be
		// read by anyone in the region, but answering one you have not taken
		// is how two agents end up telling one customer different things.
		const mayReply = canReplyToConversation(caller, {
			id: conversation.id,
			regionId: conversation.region_id,
			assignedAgentId: conversation.assigned_agent_id,
		});
		if (!mayReply.allowed) return refuse(mayReply.reason);
		// The reply is attributed to whoever is signed in. A person must not
		// be able to post as a colleague by naming them in the body.
		if (caller.kind === "user" && body.agentId !== caller.id) {
			return refuse("insufficient_role");
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
		const conversation = await repo.getConversation(id);
		if (!conversation) return json({ error: "Not found" }, 404);
		// An agent may take an unclaimed conversation and release their own.
		// Moving one from another agent is a supervisor's decision, because it
		// is how work gets taken away from someone.
		const mayAssign = canAssignConversation(
			caller,
			{
				id: conversation.id,
				regionId: conversation.region_id,
				assignedAgentId: conversation.assigned_agent_id,
			},
			body.agentId ?? null,
		);
		if (!mayAssign.allowed) return refuse(mayAssign.reason);
		const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(id));
		const actor = caller.kind === "user" ? caller.id : (body.actor ?? "api");
		await stub.assign(body.agentId, actor);
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
		const conversation = await repo.getConversation(id);
		if (!conversation) return json({ error: "Not found" }, 404);
		// Resolving is gated like replying rather than like reading: marking
		// someone else's open case resolved is the same kind of interference.
		const mayClose = canReplyToConversation(caller, {
			id: conversation.id,
			regionId: conversation.region_id,
			assignedAgentId: conversation.assigned_agent_id,
		});
		if (!mayClose.allowed) return refuse(mayClose.reason);
		const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(id));
		const statusActor =
			caller.kind === "user" ? caller.id : (body.actor ?? "api");
		await stub.setStatus(body.status, statusActor);
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
		// A template send reaches a real customer, so the region is checked
		// before anything else: this is the one console route that speaks
		// outward.
		const mayNotify = canReadRegionalRecord(caller, body.region);
		if (!mayNotify.allowed) return refuse(mayNotify.reason);
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

	const operations = await handleOperationsApi(
		request,
		url,
		env,
		segments,
		caller,
	);
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
	caller: Caller,
): Promise<Response | null> {
	const [, resource, rawId, action] = segments;
	const id = rawId ? decodeURIComponent(rawId) : undefined;
	const crm = new CrmService(env.DB);
	const repo = crm.repository;
	const region = url.searchParams.get("region") ?? undefined;
	const limit = Number(url.searchParams.get("limit") ?? "50");

	// These records are regional rather than personal: a pipeline each agent
	// can only see their own slice of stops being a pipeline. So the region is
	// the whole of the test here, unlike a conversation.
	const requested = url.searchParams.get("region");
	const scope = resolveRegionFilter(caller, requested);
	if (scope !== null && scope.length === 0) return refuse("wrong_region");

	/**
	 * Runs a listing once per region the caller may see, rather than once with
	 * no filter. The dangerous case is a restricted caller asking for no
	 * region at all: passed straight through, `undefined` means every region.
	 */
	const listScoped = async <T>(
		fn: (regionId?: string) => Promise<T[]>,
	): Promise<T[]> => {
		if (scope === null) return fn(region);
		const batches = await Promise.all(scope.map((regionId) => fn(regionId)));
		return batches.flat().slice(0, limit);
	};

	/** Refuses unless the caller may touch records of this region. */
	const guard = (regionId: string): Response | null => {
		const decision = canReadRegionalRecord(caller, regionId);
		return decision.allowed ? null : refuse(decision.reason);
	};

	/* ------------------------------------------------------------ customers */

	if (resource === "customers" && !id && request.method === "GET") {
		return json({
			customers: await listScoped((regionId) =>
				repo.listCustomers({ regionId, limit }),
			),
		});
	}

	// GET /api/customers/:id — everything Customer 360 shows, in one call.
	if (resource === "customers" && id && !action && request.method === "GET") {
		const customer = await repo.getCustomer(id);
		if (!customer) return json({ error: "Not found" }, 404);
		const denied = guard(customer.region_id);
		if (denied) return denied;
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
			leads: await listScoped((regionId) =>
				repo.listLeads({
					regionId,
					customerId: url.searchParams.get("customer") ?? undefined,
					stage: isOneOf(stage, LEAD_STAGES),
					openOnly: url.searchParams.get("open") === "true",
					limit,
				}),
			),
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
		const existingLead = await repo.getLead(id);
		if (!existingLead) return json({ error: "Not found" }, 404);
		const leadDenied = guard(existingLead.region_id);
		if (leadDenied) return leadDenied;
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
			quotations: await listScoped((regionId) =>
				repo.listQuotations({
					regionId,
					customerId: url.searchParams.get("customer") ?? undefined,
					status: isOneOf(status, QUOTATION_STATUSES),
					limit,
				}),
			),
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
		const quoteDenied = guard(body.region);
		if (quoteDenied) return quoteDenied;
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
		const existingQuote = await repo.getQuotation(id);
		if (!existingQuote) return json({ error: "Not found" }, 404);
		const moveDenied = guard(existingQuote.region_id);
		if (moveDenied) return moveDenied;
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
		const sourceQuote = await repo.getQuotation(id);
		if (!sourceQuote) return json({ error: "Not found" }, 404);
		const convertDenied = guard(sourceQuote.region_id);
		if (convertDenied) return convertDenied;
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
			bookings: await listScoped((regionId) =>
				repo.listBookings({
					regionId,
					customerId: url.searchParams.get("customer") ?? undefined,
					milestone: isOneOf(milestone, MILESTONES),
					undelivered: url.searchParams.get("active") === "true",
					limit,
				}),
			),
		});
	}

	if (resource === "bookings" && id && !action && request.method === "GET") {
		const booking = await repo.getBooking(id);
		if (!booking) return json({ error: "Not found" }, 404);
		const bookingDenied = guard(booking.region_id);
		if (bookingDenied) return bookingDenied;
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
		const targetBooking = await repo.getBooking(id);
		if (!targetBooking) return json({ error: "Not found" }, 404);
		const milestoneDenied = guard(targetBooking.region_id);
		if (milestoneDenied) return milestoneDenied;
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
			tickets: await listScoped((regionId) =>
				repo.listTickets({
					regionId,
					customerId: url.searchParams.get("customer") ?? undefined,
					status: isOneOf(status, TICKET_STATUSES),
					type: isOneOf(type, TICKET_TYPES),
					openOnly: url.searchParams.get("open") === "true",
					limit,
				}),
			),
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
		const ticketDenied = guard(body.region);
		if (ticketDenied) return ticketDenied;
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
		const existingTicket = await repo.getTicket(id);
		if (!existingTicket) return json({ error: "Not found" }, 404);
		const resolveDenied = guard(existingTicket.region_id);
		if (resolveDenied) return resolveDenied;
		const ticket = await crm.resolveTicket(id, body?.actor ?? "api");
		return json({ ticket });
	}

	/* ---------------------------------------------------------------- calls */

	if (resource === "calls" && !id && request.method === "GET") {
		return json({
			calls: await listScoped((regionId) =>
				repo.listCalls({
					regionId,
					customerId: url.searchParams.get("customer") ?? undefined,
					limit,
				}),
			),
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
		const callDenied = guard(body.region);
		if (callDenied) return callDenied;
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

	/* ------------------------------------------------------------ team chat */

	// Internal staff messaging. The one part of the platform that crosses
	// regions on purpose, so what governs a thread is membership rather than
	// region: you are in it, or you are not.
	if (resource === "chat") {
		if (caller.kind !== "user") return refuse("service_caller");
		const chat = new ChatService(env.DB);

		// GET /api/chat/threads
		if (id === "threads" && !action && request.method === "GET") {
			return json({ threads: await chat.threadsFor(caller.id, limit) });
		}

		// POST /api/chat/direct   { userId }
		if (id === "direct" && request.method === "POST") {
			const body = await readJson<{ userId?: string }>(request);
			const other = body?.userId?.trim();
			if (!other) return json({ error: "userId is required" }, 400);
			const may = canStartDirect(caller, other);
			if (!may.allowed) return refuse(may.reason);
			return json({ thread: await chat.openDirect(caller.id, other) }, 201);
		}

		// GET /api/chat/:threadId  —  the thread and its messages
		if (id && !action && request.method === "GET") {
			const thread = await chat.getThread(id);
			if (!thread) return json({ error: "Not found" }, 404);
			const participantIds = await chat.participantsOf(id);
			const may = canReadThread(caller, {
				id: thread.id,
				kind: thread.kind,
				teamId: thread.team_id,
				participantIds,
			});
			if (!may.allowed) return refuse(may.reason);
			return json({
				thread,
				participantIds,
				messages: await chat.messages(id, limit),
			});
		}

		// POST /api/chat/:threadId/messages   { body, refKind?, refId? }
		if (id && action === "messages" && request.method === "POST") {
			const payload = await readJson<{
				body?: string;
				refKind?: string;
				refId?: string;
			}>(request);
			const thread = await chat.getThread(id);
			if (!thread) return json({ error: "Not found" }, 404);
			const participantIds = await chat.participantsOf(id);
			const may = canPostToThread(
				caller,
				{
					id: thread.id,
					kind: thread.kind,
					teamId: thread.team_id,
					participantIds,
				},
				payload?.body ?? "",
			);
			if (!may.allowed) return refuse(may.reason);

			// A reference is an id and nothing else. Following it goes through
			// the ordinary scoped routes, so a reader who should not see the
			// record still cannot.
			const rawRefKind = payload?.refKind;
			if (rawRefKind !== undefined && !isRefKind(rawRefKind)) {
				return json({ error: "refKind is not one this platform knows" }, 400);
			}
			const message = await chat.post({
				threadId: id,
				authorId: caller.id,
				body: payload?.body ?? "",
				refKind: rawRefKind ?? null,
				refId: payload?.refId ?? null,
			});
			return json({ message }, 201);
		}

		// POST /api/chat/:threadId/read
		if (id && action === "read" && request.method === "POST") {
			const thread = await chat.getThread(id);
			if (!thread) return json({ error: "Not found" }, 404);
			const participantIds = await chat.participantsOf(id);
			const may = canReadThread(caller, {
				id: thread.id,
				kind: thread.kind,
				teamId: thread.team_id,
				participantIds,
			});
			if (!may.allowed) return refuse(may.reason);
			await chat.markRead(id, caller.id);
			return json({ ok: true });
		}
	}

	/* -------------------------------------------------------------- contacts */

	// GET /api/contacts?region=&q=&stage=&limit=
	//
	// The directory. Every row carries its derived lifecycle stage and
	// temperature, so a list and a contact record cannot disagree.
	if (resource === "contacts" && !id && request.method === "GET") {
		const regionIds =
			scope === null
				? requested
					? [requested]
					: parseRegionConfig(env.REGION_NUMBERS).map((r) => r.id)
				: scope;

		const stageParam = url.searchParams.get("stage");
		if (stageParam !== null && !isCustomerStage(stageParam)) {
			return json(
				{ error: `stage must be one of ${CUSTOMER_STAGES.join(", ")}` },
				400,
			);
		}
		const stage = stageParam === null ? null : stageParam;

		const contacts = new Contacts(env.DB);
		return json(
			await contacts.list({
				regionIds,
				search: url.searchParams.get("q"),
				stage,
				limit,
			}),
		);
	}

	// GET /api/contacts/board?region=&per=
	//
	// The lifecycle board: one column per stage, warmest first within each.
	if (resource === "contacts" && id === "board" && request.method === "GET") {
		const regionIds =
			scope === null
				? requested
					? [requested]
					: parseRegionConfig(env.REGION_NUMBERS).map((r) => r.id)
				: scope;

		const contacts = new Contacts(env.DB);
		return json(
			await contacts.board(regionIds, {
				perColumn: Number(url.searchParams.get("per") ?? "5"),
			}),
		);
	}

	/* --------------------------------------------------------------- reports */

	// GET /api/reports/summary?region=&from=&to=
	//
	// The dashboard and the report library both read this. Agents are refused:
	// regional performance figures are a management view, and the design puts
	// reports behind supervisors.
	if (resource === "reports" && id === "summary" && request.method === "GET") {
		const mayView = canViewReports(caller);
		if (!mayView.allowed) return refuse(mayView.reason);

		// Which regions this person may report on — not which they asked for.
		const reportable = reportableRegions(caller);
		const requested = url.searchParams.get("region");
		const regionIds =
			reportable === null
				? requested
					? [requested]
					: parseRegionConfig(env.REGION_NUMBERS).map((r) => r.id)
				: requested
					? reportable.filter((r) => r === requested)
					: reportable;

		if (regionIds.length === 0) return refuse("wrong_region");

		const window = parseWindow(
			url.searchParams.get("from"),
			url.searchParams.get("to"),
		);
		const reports = new Reports(env.DB);
		return json(await reports.summary(regionIds, window));
	}

	/* ------------------------------------------------------- stalled sweep */

	// POST /api/operations/sweep-stalled — opens a ticket for each shipment
	// that has gone quiet. Safe to call repeatedly; it will not duplicate.
	if (
		resource === "operations" &&
		id === "sweep-stalled" &&
		request.method === "POST"
	) {
		// The sweep crosses every region by design, so it is not something a
		// regional user may set running.
		const maySweep = canAdminister(caller);
		if (!maySweep.allowed && caller.kind !== "service") {
			return refuse(maySweep.reason);
		}
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
