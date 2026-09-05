/**
 * Thin data-access layer over D1. All SQL lives here so the Durable Object
 * and HTTP handlers stay readable and the schema can evolve in one place.
 */

export type ConversationStatus = "open" | "pending" | "resolved";
export type MessageDirection = "in" | "out";
export type PresenceStatus = "online" | "away" | "offline";

export interface ConversationRow {
	id: string;
	wa_id: string;
	phone_number_id: string;
	region_id: string;
	status: ConversationStatus;
	assigned_agent_id: string | null;
	window_expires_at: string | null;
	last_inbound_at: string | null;
	last_outbound_at: string | null;
	last_message_preview: string | null;
	unread_count: number;
	created_at: string;
	updated_at: string;
}

export interface MessageRow {
	id: string;
	conversation_id: string;
	direction: MessageDirection;
	type: string;
	body: string | null;
	media_key: string | null;
	media_mime: string | null;
	status: string | null;
	error_code: number | null;
	error_message: string | null;
	sent_by: string | null;
	wa_timestamp: string;
	raw_json: string | null;
	created_at: string;
}

export interface NewMessage {
	id: string;
	conversationId: string;
	direction: MessageDirection;
	type: string;
	body?: string | null;
	mediaKey?: string | null;
	mediaMime?: string | null;
	status?: string | null;
	sentBy?: string | null;
	waTimestamp: string;
	rawJson?: string | null;
}

export class Repository {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	async upsertContact(
		waId: string,
		profileName: string | undefined,
		regionId: string,
		now: string,
	): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO contacts (wa_id, profile_name, region_id, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?4)
				 ON CONFLICT(wa_id) DO UPDATE SET
				   profile_name = COALESCE(excluded.profile_name, contacts.profile_name),
				   region_id = excluded.region_id,
				   updated_at = excluded.updated_at`,
			)
			.bind(waId, profileName ?? null, regionId, now)
			.run();
	}

	async upsertConversationOnInbound(input: {
		id: string;
		waId: string;
		phoneNumberId: string;
		regionId: string;
		windowExpiresAt: string;
		inboundAt: string;
		preview: string;
	}): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO conversations
				   (id, wa_id, phone_number_id, region_id, status, window_expires_at,
				    last_inbound_at, last_message_preview, unread_count, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?6, ?7, 1, ?6, ?6)
				 ON CONFLICT(id) DO UPDATE SET
				   status = CASE WHEN conversations.status = 'resolved' THEN 'open' ELSE conversations.status END,
				   window_expires_at = excluded.window_expires_at,
				   last_inbound_at = excluded.last_inbound_at,
				   last_message_preview = excluded.last_message_preview,
				   unread_count = conversations.unread_count + 1,
				   updated_at = excluded.updated_at`,
			)
			.bind(
				input.id,
				input.waId,
				input.phoneNumberId,
				input.regionId,
				input.windowExpiresAt,
				input.inboundAt,
				input.preview,
			)
			.run();
	}

	async ensureConversation(input: {
		id: string;
		waId: string;
		phoneNumberId: string;
		regionId: string;
		now: string;
	}): Promise<void> {
		await this.db
			.prepare(
				`INSERT OR IGNORE INTO conversations
				   (id, wa_id, phone_number_id, region_id, status, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5)`,
			)
			.bind(
				input.id,
				input.waId,
				input.phoneNumberId,
				input.regionId,
				input.now,
			)
			.run();
	}

	async touchConversationOnOutbound(
		id: string,
		outboundAt: string,
		preview: string,
	): Promise<void> {
		await this.db
			.prepare(
				`UPDATE conversations
				 SET last_outbound_at = ?2, last_message_preview = ?3, updated_at = ?2
				 WHERE id = ?1`,
			)
			.bind(id, outboundAt, preview)
			.run();
	}

	/** Returns true when the row was inserted, false when it already existed. */
	async insertMessage(m: NewMessage, now: string): Promise<boolean> {
		const result = await this.db
			.prepare(
				`INSERT OR IGNORE INTO messages
				   (id, conversation_id, direction, type, body, media_key, media_mime,
				    status, sent_by, wa_timestamp, raw_json, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
			)
			.bind(
				m.id,
				m.conversationId,
				m.direction,
				m.type,
				m.body ?? null,
				m.mediaKey ?? null,
				m.mediaMime ?? null,
				m.status ?? null,
				m.sentBy ?? null,
				m.waTimestamp,
				m.rawJson ?? null,
				now,
			)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}

	async updateMessageMedia(
		id: string,
		mediaKey: string,
		mediaMime: string,
	): Promise<void> {
		await this.db
			.prepare(
				`UPDATE messages SET media_key = ?2, media_mime = ?3 WHERE id = ?1`,
			)
			.bind(id, mediaKey, mediaMime)
			.run();
	}

	async updateMessageStatus(
		id: string,
		status: string,
		errorCode?: number,
		errorMessage?: string,
	): Promise<void> {
		await this.db
			.prepare(
				`UPDATE messages
				 SET status = ?2,
				     error_code = COALESCE(?3, error_code),
				     error_message = COALESCE(?4, error_message)
				 WHERE id = ?1`,
			)
			.bind(id, status, errorCode ?? null, errorMessage ?? null)
			.run();
	}

	async listConversations(filter: {
		regionId?: string;
		status?: ConversationStatus;
		agentId?: string;
		limit?: number;
	}): Promise<ConversationRow[]> {
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (filter.regionId) {
			params.push(filter.regionId);
			clauses.push(`region_id = ?${params.length}`);
		}
		if (filter.status) {
			params.push(filter.status);
			clauses.push(`status = ?${params.length}`);
		}
		if (filter.agentId) {
			params.push(filter.agentId);
			clauses.push(`assigned_agent_id = ?${params.length}`);
		}
		params.push(Math.min(Math.max(filter.limit ?? 50, 1), 200));
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const { results } = await this.db
			.prepare(
				`SELECT * FROM conversations ${where}
				 ORDER BY updated_at DESC LIMIT ?${params.length}`,
			)
			.bind(...params)
			.all<ConversationRow>();
		return results;
	}

	async getConversation(id: string): Promise<ConversationRow | null> {
		return this.db
			.prepare(`SELECT * FROM conversations WHERE id = ?1`)
			.bind(id)
			.first<ConversationRow>();
	}

	async listMessages(
		conversationId: string,
		limit = 50,
	): Promise<MessageRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT * FROM messages WHERE conversation_id = ?1
				 ORDER BY wa_timestamp DESC LIMIT ?2`,
			)
			.bind(conversationId, Math.min(Math.max(limit, 1), 500))
			.all<MessageRow>();
		return results.reverse();
	}

	async assignConversation(
		id: string,
		agentId: string | null,
		now: string,
	): Promise<void> {
		await this.db
			.prepare(
				`UPDATE conversations SET assigned_agent_id = ?2, updated_at = ?3 WHERE id = ?1`,
			)
			.bind(id, agentId, now)
			.run();
	}

	async setConversationStatus(
		id: string,
		status: ConversationStatus,
		now: string,
	): Promise<void> {
		await this.db
			.prepare(
				`UPDATE conversations SET status = ?2, updated_at = ?3 WHERE id = ?1`,
			)
			.bind(id, status, now)
			.run();
	}

	async clearUnread(id: string): Promise<void> {
		await this.db
			.prepare(`UPDATE conversations SET unread_count = 0 WHERE id = ?1`)
			.bind(id)
			.run();
	}

	async countOnlineAgents(regionId: string): Promise<number> {
		const row = await this.db
			.prepare(
				`SELECT COUNT(*) AS n
				 FROM agents a JOIN agent_presence p ON p.agent_id = a.id
				 WHERE a.active = 1 AND p.status = 'online'
				   AND (a.region_id IS NULL OR a.region_id = ?1)`,
			)
			.bind(regionId)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	async setAgentPresence(
		agentId: string,
		status: PresenceStatus,
		now: string,
	): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO agent_presence (agent_id, status, updated_at) VALUES (?1, ?2, ?3)
				 ON CONFLICT(agent_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
			)
			.bind(agentId, status, now)
			.run();
	}

	async recordTemplateSend(input: {
		conversationId: string;
		templateName: string;
		languageCode: string;
		toWaId: string;
		waMessageId: string | null;
		requestedBy: string;
		now: string;
	}): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO template_sends
				   (conversation_id, template_name, language_code, to_wa_id, wa_message_id, requested_by, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
			)
			.bind(
				input.conversationId,
				input.templateName,
				input.languageCode,
				input.toWaId,
				input.waMessageId,
				input.requestedBy,
				input.now,
			)
			.run();
	}

	async audit(
		actor: string,
		action: string,
		conversationId: string | null,
		details: unknown,
		now: string,
	): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO audit_log (actor, action, conversation_id, details, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5)`,
			)
			.bind(
				actor,
				action,
				conversationId,
				details === undefined ? null : JSON.stringify(details),
				now,
			)
			.run();
	}
}
