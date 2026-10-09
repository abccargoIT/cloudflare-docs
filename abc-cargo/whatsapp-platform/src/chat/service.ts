/**
 * Internal staff messaging.
 *
 * The one thing to keep in mind reading this: a chat message may point at a
 * customer record, but it never carries one. The reference is an id, and
 * following it goes back through the ordinary scoped routes, which refuse a
 * reader who should not see it. That is what stops team chat becoming a way
 * around the regional rules the rest of the platform enforces.
 */

import { directKey, unreadCount, type ThreadKind } from "./policy.ts";

export interface ThreadRow {
	id: string;
	kind: ThreadKind;
	team_id: string | null;
	title: string | null;
	direct_key: string | null;
	created_by: string;
	created_at: string;
	updated_at: string;
	last_message_at: string | null;
}

export interface MessageRow {
	id: string;
	thread_id: string;
	author_id: string;
	body: string;
	ref_kind: string | null;
	ref_id: string | null;
	created_at: string;
	edited_at: string | null;
}

export interface ThreadSummary {
	thread: ThreadRow;
	participantIds: string[];
	unread: number;
	lastMessage: MessageRow | null;
}

const REF_KINDS = ["conversation", "customer", "ticket", "booking"] as const;
export type RefKind = (typeof REF_KINDS)[number];

export function isRefKind(value: string): value is RefKind {
	return (REF_KINDS as readonly string[]).includes(value);
}

/** Messages are long enough to be useful and short enough not to be a document. */
export const MAX_MESSAGE_LENGTH = 4000;

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

export class ChatService {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	/** The threads a person is in, most recently active first. */
	async threadsFor(userId: string, limit = 50): Promise<ThreadSummary[]> {
		const { results: threads } = await this.db
			.prepare(
				`SELECT t.*, p.last_read_at AS reader_last_read
				 FROM chat_threads t
				 JOIN chat_participants p ON p.thread_id = t.id
				 WHERE p.user_id = ?1
				 ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
				 LIMIT ?2`,
			)
			.bind(userId, Math.min(Math.max(limit, 1), 200))
			.all<ThreadRow & { reader_last_read: string | null }>();

		const rows = threads ?? [];
		if (rows.length === 0) return [];

		const ids = rows.map((row) => row.id);
		const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");

		// Participants and recent messages for the whole page at once, rather
		// than per thread. Same reasoning as the contacts directory.
		const [{ results: participants }, { results: messages }] =
			await Promise.all([
				this.db
					.prepare(
						`SELECT thread_id, user_id FROM chat_participants
						 WHERE thread_id IN (${placeholders})`,
					)
					.bind(...ids)
					.all<{ thread_id: string; user_id: string }>(),
				this.db
					.prepare(
						`SELECT * FROM chat_messages
						 WHERE thread_id IN (${placeholders})
						 ORDER BY created_at DESC`,
					)
					.bind(...ids)
					.all<MessageRow>(),
			]);

		const byThreadParticipants = new Map<string, string[]>();
		for (const row of participants ?? []) {
			const list = byThreadParticipants.get(row.thread_id);
			if (list) list.push(row.user_id);
			else byThreadParticipants.set(row.thread_id, [row.user_id]);
		}

		const byThreadMessages = new Map<string, MessageRow[]>();
		for (const message of messages ?? []) {
			const list = byThreadMessages.get(message.thread_id);
			if (list) list.push(message);
			else byThreadMessages.set(message.thread_id, [message]);
		}

		return rows.map((row) => {
			const theirMessages = byThreadMessages.get(row.id) ?? [];
			return {
				thread: row,
				participantIds: byThreadParticipants.get(row.id) ?? [],
				unread: unreadCount(
					theirMessages.map((m) => ({
						createdAt: m.created_at,
						authorId: m.author_id,
					})),
					row.reader_last_read,
					userId,
				),
				// Ordered newest first by the query above.
				lastMessage: theirMessages[0] ?? null,
			};
		});
	}

	async getThread(threadId: string): Promise<ThreadRow | null> {
		return this.db
			.prepare(`SELECT * FROM chat_threads WHERE id = ?1`)
			.bind(threadId)
			.first<ThreadRow>();
	}

	async participantsOf(threadId: string): Promise<string[]> {
		const { results } = await this.db
			.prepare(`SELECT user_id FROM chat_participants WHERE thread_id = ?1`)
			.bind(threadId)
			.all<{ user_id: string }>();
		return (results ?? []).map((row) => row.user_id);
	}

	async messages(threadId: string, limit = 100): Promise<MessageRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT * FROM chat_messages WHERE thread_id = ?1
				 ORDER BY created_at DESC LIMIT ?2`,
			)
			.bind(threadId, Math.min(Math.max(limit, 1), 500))
			.all<MessageRow>();
		// Oldest first for display; the query takes the newest page.
		return (results ?? []).reverse();
	}

	/**
	 * Finds or opens the direct thread between two people.
	 *
	 * Idempotent on purpose. Two colleagues starting a conversation from
	 * opposite ends at the same moment must land in one thread, or each sees
	 * half of it and neither knows.
	 */
	async openDirect(
		userId: string,
		otherUserId: string,
		now: Date = new Date(),
	): Promise<ThreadRow> {
		const key = directKey(userId, otherUserId);
		const existing = await this.db
			.prepare(`SELECT * FROM chat_threads WHERE direct_key = ?1`)
			.bind(key)
			.first<ThreadRow>();
		if (existing) return existing;

		const nowIso = now.toISOString();
		const id = newId("thr");
		await this.db.batch([
			this.db
				.prepare(
					`INSERT INTO chat_threads
					   (id, kind, team_id, title, direct_key, created_by, created_at, updated_at, last_message_at)
					 VALUES (?1, 'direct', NULL, NULL, ?2, ?3, ?4, ?4, NULL)
					 ON CONFLICT (direct_key) DO NOTHING`,
				)
				.bind(id, key, userId, nowIso),
			this.db
				.prepare(
					`INSERT INTO chat_participants (thread_id, user_id, added_at)
					 SELECT id, ?2, ?3 FROM chat_threads WHERE direct_key = ?1
					 ON CONFLICT (thread_id, user_id) DO NOTHING`,
				)
				.bind(key, userId, nowIso),
			this.db
				.prepare(
					`INSERT INTO chat_participants (thread_id, user_id, added_at)
					 SELECT id, ?2, ?3 FROM chat_threads WHERE direct_key = ?1
					 ON CONFLICT (thread_id, user_id) DO NOTHING`,
				)
				.bind(key, otherUserId, nowIso),
		]);

		// Re-read rather than returning what was written: another request may
		// have won the insert, and the row that exists is the one that counts.
		const created = await this.db
			.prepare(`SELECT * FROM chat_threads WHERE direct_key = ?1`)
			.bind(key)
			.first<ThreadRow>();
		if (!created) throw new Error("failed to open the direct thread");
		return created;
	}

	async post(input: {
		threadId: string;
		authorId: string;
		body: string;
		refKind?: RefKind | null;
		refId?: string | null;
		now?: Date;
	}): Promise<MessageRow> {
		const now = input.now ?? new Date();
		const nowIso = now.toISOString();
		const id = newId("msg");
		const body = input.body.trim().slice(0, MAX_MESSAGE_LENGTH);

		await this.db.batch([
			this.db
				.prepare(
					`INSERT INTO chat_messages
					   (id, thread_id, author_id, body, ref_kind, ref_id, created_at, edited_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)`,
				)
				.bind(
					id,
					input.threadId,
					input.authorId,
					body,
					input.refKind ?? null,
					input.refId ?? null,
					nowIso,
				),
			this.db
				.prepare(
					`UPDATE chat_threads SET last_message_at = ?2, updated_at = ?2
					 WHERE id = ?1`,
				)
				.bind(input.threadId, nowIso),
			// Posting is reading: nobody should return to their own message as
			// an unread one.
			this.db
				.prepare(
					`UPDATE chat_participants SET last_read_at = ?3
					 WHERE thread_id = ?1 AND user_id = ?2`,
				)
				.bind(input.threadId, input.authorId, nowIso),
		]);

		const created = await this.db
			.prepare(`SELECT * FROM chat_messages WHERE id = ?1`)
			.bind(id)
			.first<MessageRow>();
		if (!created) throw new Error("failed to post the message");
		return created;
	}

	/** Moves the reader's mark to now. */
	async markRead(
		threadId: string,
		userId: string,
		now: Date = new Date(),
	): Promise<void> {
		await this.db
			.prepare(
				`UPDATE chat_participants SET last_read_at = ?3
				 WHERE thread_id = ?1 AND user_id = ?2`,
			)
			.bind(threadId, userId, now.toISOString())
			.run();
	}
}
