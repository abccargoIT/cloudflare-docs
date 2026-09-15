import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { Repository, type ConversationStatus } from "./db/repo.ts";
import { WhatsAppClient } from "./whatsapp/client.ts";
import type {
	InboundMessage,
	TemplateSendRequest,
	WebhookContact,
} from "./whatsapp/types.ts";
import {
	findRegionByPhoneNumberId,
	parseRegionConfig,
	type RegionConfig,
} from "./regions.ts";
import { isWithinBusinessHours } from "./business-hours.ts";
import { buildAutoReply, type AutoReplyReason } from "./auto-reply.ts";

/** Meta allows free-form replies for 24 hours after the last customer message. */
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const MEDIA_TYPES = new Set(["image", "document", "audio", "video", "sticker"]);

export interface ConversationState {
	id: string;
	phoneNumberId: string;
	waId: string;
	regionId: string;
	profileName?: string;
	status: ConversationStatus;
	assignedAgentId: string | null;
	windowExpiresAt?: string;
	lastAutoReplyAt?: string;
}

export interface InboundEvent {
	phoneNumberId: string;
	contact?: WebhookContact;
	message: InboundMessage;
	receivedAt: string;
}

export interface ConversationInit {
	phoneNumberId: string;
	waId: string;
}

export class WindowClosedError extends Error {
	constructor() {
		super(
			"The 24-hour customer service window is closed. Send an approved template message instead.",
		);
		this.name = "WindowClosedError";
	}
}

export function conversationIdFor(phoneNumberId: string, waId: string): string {
	return `${phoneNumberId}:${waId}`;
}

/**
 * One Durable Object instance per (business number, customer) pair.
 * Serialises all work for a thread so that ordering, de-duplication,
 * window tracking and the "reply once" rule for automated replies hold
 * even when Meta delivers webhooks concurrently or retries them.
 */
export class Conversation extends DurableObject<Env> {
	private readonly regions: RegionConfig[];
	private readonly client: WhatsAppClient;
	private readonly repo: Repository;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.regions = parseRegionConfig(env.REGION_NUMBERS);
		this.client = new WhatsAppClient({
			accessToken: env.WHATSAPP_ACCESS_TOKEN,
			graphApiVersion: env.GRAPH_API_VERSION,
		});
		this.repo = new Repository(env.DB);
	}

	// ---------------------------------------------------------------- inbound

	async handleInbound(
		event: InboundEvent,
	): Promise<{ duplicate: boolean; autoReplied: boolean }> {
		const region = this.requireRegion(event.phoneNumberId);
		const message = event.message;
		const state = await this.ensureState(
			{ phoneNumberId: event.phoneNumberId, waId: message.from },
			region,
		);
		if (event.contact?.profile?.name) {
			state.profileName = event.contact.profile.name;
		}

		const receivedAt = new Date(event.receivedAt);
		const waTimestamp = new Date(Number(message.timestamp) * 1000);
		const nowIso = receivedAt.toISOString();
		const preview = previewFor(message);

		const inserted = await this.repo.insertMessage(
			{
				id: message.id,
				conversationId: state.id,
				direction: "in",
				type: message.type,
				body: bodyFor(message),
				status: "received",
				waTimestamp: waTimestamp.toISOString(),
				rawJson: JSON.stringify(message),
			},
			nowIso,
		);
		if (!inserted) {
			// Meta retried a webhook we already processed.
			return { duplicate: true, autoReplied: false };
		}

		// Customer message opens / extends the 24-hour service window.
		const windowExpiresAt = new Date(
			waTimestamp.getTime() + SERVICE_WINDOW_MS,
		).toISOString();
		state.windowExpiresAt = windowExpiresAt;
		if (state.status === "resolved") state.status = "open";

		await this.repo.upsertContact(
			state.waId,
			state.profileName,
			region.id,
			nowIso,
		);
		await this.repo.upsertConversationOnInbound({
			id: state.id,
			waId: state.waId,
			phoneNumberId: state.phoneNumberId,
			regionId: region.id,
			windowExpiresAt,
			inboundAt: nowIso,
			preview,
		});
		await this.saveState(state);
		await this.ctx.storage.setAlarm(new Date(windowExpiresAt).getTime());

		await this.storeMediaIfAny(state.id, message);

		// Best effort: blue ticks on the customer's side.
		try {
			await this.client.markAsRead(state.phoneNumberId, message.id);
		} catch (error) {
			console.warn("markAsRead failed", describeError(error));
		}

		const reason = await this.autoReplyReason(state, region, receivedAt);
		if (!reason) return { duplicate: false, autoReplied: false };

		const text = buildAutoReply({
			region,
			reason,
			contactName: state.profileName,
			inboundText: message.text?.body,
			trackingUrl: this.env.TRACKING_URL || undefined,
		});
		await this.sendTextInternal(state, text, "auto");
		state.lastAutoReplyAt = nowIso;
		await this.saveState(state);
		await this.repo.audit("auto", "auto_reply", state.id, { reason }, nowIso);
		return { duplicate: false, autoReplied: true };
	}

	// --------------------------------------------------------------- outbound

	/** Free-form agent reply. Only valid while the service window is open. */
	async reply(input: {
		agentId: string;
		text: string;
	}): Promise<{ messageId: string }> {
		const state = await this.requireState();
		if (!this.windowOpen(state)) throw new WindowClosedError();
		const messageId = await this.sendTextInternal(
			state,
			input.text,
			input.agentId,
		);
		await this.repo.clearUnread(state.id);
		return { messageId };
	}

	/**
	 * Business-initiated message using a Meta-approved template. Works
	 * whether or not the window is open, so it is the path for shipment
	 * notifications and for re-engaging a customer after 24 hours.
	 */
	async sendTemplate(input: {
		init: ConversationInit;
		requestedBy: string;
		template: TemplateSendRequest;
	}): Promise<{ messageId: string }> {
		const region = this.requireRegion(input.init.phoneNumberId);
		const state = await this.ensureState(input.init, region);
		const nowIso = new Date().toISOString();

		const response = await this.client.sendTemplate(
			state.phoneNumberId,
			state.waId,
			input.template,
		);
		const messageId = response.messages[0]?.id ?? "";

		await this.repo.insertMessage(
			{
				id: messageId,
				conversationId: state.id,
				direction: "out",
				type: "template",
				body: `[template] ${input.template.name} (${input.template.languageCode})`,
				status: "accepted",
				sentBy: input.requestedBy,
				waTimestamp: nowIso,
				rawJson: JSON.stringify(input.template),
			},
			nowIso,
		);
		await this.repo.touchConversationOnOutbound(
			state.id,
			nowIso,
			`[template] ${input.template.name}`,
		);
		await this.repo.recordTemplateSend({
			conversationId: state.id,
			templateName: input.template.name,
			languageCode: input.template.languageCode,
			toWaId: state.waId,
			waMessageId: messageId || null,
			requestedBy: input.requestedBy,
			now: nowIso,
		});
		return { messageId };
	}

	// ----------------------------------------------------------- management

	async assign(agentId: string | null, actor: string): Promise<void> {
		const state = await this.requireState();
		const nowIso = new Date().toISOString();
		state.assignedAgentId = agentId;
		await this.saveState(state);
		await this.repo.assignConversation(state.id, agentId, nowIso);
		await this.repo.audit(actor, "assign", state.id, { agentId }, nowIso);
	}

	async setStatus(status: ConversationStatus, actor: string): Promise<void> {
		const state = await this.requireState();
		const nowIso = new Date().toISOString();
		state.status = status;
		await this.saveState(state);
		await this.repo.setConversationStatus(state.id, status, nowIso);
		await this.repo.audit(actor, "set_status", state.id, { status }, nowIso);
	}

	async getState(): Promise<
		(ConversationState & { windowOpen: boolean }) | null
	> {
		const state = await this.loadState();
		if (!state) return null;
		return { ...state, windowOpen: this.windowOpen(state) };
	}

	/** Fires when the service window closes. */
	async alarm(): Promise<void> {
		const state = await this.loadState();
		if (!state) return;
		if (this.windowOpen(state)) return;
		await this.repo.audit(
			"system",
			"window_closed",
			state.id,
			{ windowExpiresAt: state.windowExpiresAt },
			new Date().toISOString(),
		);
	}

	// -------------------------------------------------------------- helpers

	private async sendTextInternal(
		state: ConversationState,
		text: string,
		sentBy: string,
	): Promise<string> {
		const nowIso = new Date().toISOString();
		const response = await this.client.sendText(
			state.phoneNumberId,
			state.waId,
			text,
		);
		const messageId = response.messages[0]?.id ?? "";
		await this.repo.insertMessage(
			{
				id: messageId,
				conversationId: state.id,
				direction: "out",
				type: "text",
				body: text,
				status: "accepted",
				sentBy,
				waTimestamp: nowIso,
			},
			nowIso,
		);
		await this.repo.touchConversationOnOutbound(
			state.id,
			nowIso,
			text.slice(0, 120),
		);
		return messageId;
	}

	private async autoReplyReason(
		state: ConversationState,
		region: RegionConfig,
		now: Date,
	): Promise<AutoReplyReason | undefined> {
		if (state.assignedAgentId) return undefined;

		const cooldownHours = Number(this.env.AUTO_REPLY_COOLDOWN_HOURS || "12");
		if (state.lastAutoReplyAt) {
			const elapsed = now.getTime() - new Date(state.lastAutoReplyAt).getTime();
			if (elapsed < cooldownHours * 60 * 60 * 1000) return undefined;
		}

		if (!isWithinBusinessHours(region, now)) return "outside-hours";
		const online = await this.repo.countOnlineAgents(region.id);
		if (online === 0) return "no-agents-online";
		return undefined;
	}

	private async storeMediaIfAny(
		conversationId: string,
		message: InboundMessage,
	): Promise<void> {
		if (!MEDIA_TYPES.has(message.type)) return;
		const media =
			message.image ??
			message.document ??
			message.audio ??
			message.video ??
			message.sticker;
		if (!media) return;
		try {
			const { bytes, mimeType } = await this.client.downloadMedia(media.id);
			const key = `conversations/${conversationId}/${message.id}`;
			await this.env.MEDIA.put(key, bytes, {
				httpMetadata: { contentType: mimeType },
				customMetadata: {
					waMediaId: media.id,
					filename: media.filename ?? "",
				},
			});
			await this.repo.updateMessageMedia(message.id, key, mimeType);
		} catch (error) {
			// Media links expire quickly; a failed download is logged, not fatal.
			console.error("media download failed", describeError(error));
		}
	}

	private windowOpen(state: ConversationState): boolean {
		return (
			!!state.windowExpiresAt && new Date(state.windowExpiresAt) > new Date()
		);
	}

	private requireRegion(phoneNumberId: string): RegionConfig {
		const region = findRegionByPhoneNumberId(this.regions, phoneNumberId);
		if (!region) {
			throw new Error(
				`No region configured for phone number id ${phoneNumberId}`,
			);
		}
		return region;
	}

	private async ensureState(
		init: ConversationInit,
		region: RegionConfig,
	): Promise<ConversationState> {
		const existing = await this.loadState();
		if (existing) return existing;
		const nowIso = new Date().toISOString();
		const state: ConversationState = {
			id: conversationIdFor(init.phoneNumberId, init.waId),
			phoneNumberId: init.phoneNumberId,
			waId: init.waId,
			regionId: region.id,
			status: "pending",
			assignedAgentId: null,
		};
		await this.repo.ensureConversation({
			id: state.id,
			waId: state.waId,
			phoneNumberId: state.phoneNumberId,
			regionId: region.id,
			now: nowIso,
		});
		await this.saveState(state);
		return state;
	}

	private async requireState(): Promise<ConversationState> {
		const state = await this.loadState();
		if (!state) throw new Error("Conversation has not been initialised");
		return state;
	}

	private loadState(): Promise<ConversationState | undefined> {
		return this.ctx.storage.get<ConversationState>("state");
	}

	private saveState(state: ConversationState): Promise<void> {
		return this.ctx.storage.put("state", state);
	}
}

export function bodyFor(message: InboundMessage): string | null {
	switch (message.type) {
		case "text":
			return message.text?.body ?? null;
		case "interactive":
			return (
				message.interactive?.button_reply?.title ??
				message.interactive?.list_reply?.title ??
				null
			);
		case "button":
			return message.button?.text ?? null;
		case "location":
			return message.location
				? `${message.location.latitude},${message.location.longitude}`
				: null;
		case "reaction":
			return message.reaction?.emoji ?? null;
		case "image":
		case "document":
		case "audio":
		case "video":
		case "sticker": {
			const media =
				message.image ??
				message.document ??
				message.audio ??
				message.video ??
				message.sticker;
			return media?.caption ?? media?.filename ?? null;
		}
		default:
			return null;
	}
}

export function previewFor(message: InboundMessage): string {
	const body = bodyFor(message);
	if (body) return body.slice(0, 120);
	return `[${message.type}]`;
}

function describeError(error: unknown): string {
	return error instanceof Error
		? `${error.name}: ${error.message}`
		: String(error);
}
