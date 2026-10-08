/**
 * Internal notes on a conversation.
 *
 * The one piece of text in this platform that must never reach the customer.
 * It lives in its own table for that reason — see `0010_composer.sql` — and
 * nothing in this file sends anything anywhere. There is no WhatsApp client
 * here, no phone number, and no path from a note to the Cloud API.
 *
 * Who may read a note is the same question as who may read the conversation
 * it is attached to, so that decision is not re-made here: the route asks
 * `canReadConversation` and this is only reached once it has allowed it.
 */

export const MAX_NOTE_LENGTH = 4000;

export interface NoteRow {
	id: string;
	conversation_id: string;
	region_id: string;
	author_id: string;
	body: string;
	pinned: number;
	created_at: string;
	edited_at: string | null;
}

export type NoteRefusal = "empty_note" | "not_the_author" | "not_found";

export type NoteCheck =
	{ ok: true } | { ok: false; reason: NoteRefusal; message: string };

/** An empty note is refused rather than stored as a blank row. */
export function checkNoteBody(body: string | undefined): NoteCheck {
	if (!body || body.trim().length === 0) {
		return {
			ok: false,
			reason: "empty_note",
			message: "a note needs some text",
		};
	}
	return { ok: true };
}

/**
 * Only the author edits their own note.
 *
 * The same rule as team chat, for the same reason: rewriting a colleague's
 * words under their name is not something to make easy. A supervisor who
 * disagrees with a note adds their own, which leaves both on the record.
 */
export function canEditNote(actorId: string, note: NoteRow): NoteCheck {
	if (note.author_id !== actorId) {
		return {
			ok: false,
			reason: "not_the_author",
			message: "only the person who wrote a note may change it",
		};
	}
	return { ok: true };
}

function newId(): string {
	return `note_${crypto.randomUUID()}`;
}

export class Notes {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	/** Pinned first, then newest. The handover note has to be visible. */
	async forConversation(
		conversationId: string,
		limit = 100,
	): Promise<NoteRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT * FROM conversation_notes WHERE conversation_id = ?1
				 ORDER BY pinned DESC, created_at DESC LIMIT ?2`,
			)
			.bind(conversationId, Math.min(Math.max(limit, 1), 500))
			.all<NoteRow>();
		return results ?? [];
	}

	async get(id: string): Promise<NoteRow | null> {
		return this.db
			.prepare(`SELECT * FROM conversation_notes WHERE id = ?1`)
			.bind(id)
			.first<NoteRow>();
	}

	async add(input: {
		conversationId: string;
		regionId: string;
		authorId: string;
		body: string;
		pinned?: boolean;
		now?: Date;
	}): Promise<NoteRow> {
		const nowIso = (input.now ?? new Date()).toISOString();
		const id = newId();
		await this.db
			.prepare(
				`INSERT INTO conversation_notes
				   (id, conversation_id, region_id, author_id, body, pinned, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
			)
			.bind(
				id,
				input.conversationId,
				input.regionId,
				input.authorId,
				input.body.trim().slice(0, MAX_NOTE_LENGTH),
				input.pinned ? 1 : 0,
				nowIso,
			)
			.run();
		const created = await this.get(id);
		if (!created) throw new Error("failed to add the note");
		return created;
	}

	async edit(input: {
		id: string;
		body: string;
		now?: Date;
	}): Promise<NoteRow> {
		const nowIso = (input.now ?? new Date()).toISOString();
		await this.db
			.prepare(
				`UPDATE conversation_notes SET body = ?2, edited_at = ?3 WHERE id = ?1`,
			)
			.bind(input.id, input.body.trim().slice(0, MAX_NOTE_LENGTH), nowIso)
			.run();
		const updated = await this.get(input.id);
		if (!updated) throw new Error("the note disappeared");
		return updated;
	}

	async setPinned(id: string, pinned: boolean): Promise<void> {
		await this.db
			.prepare(`UPDATE conversation_notes SET pinned = ?2 WHERE id = ?1`)
			.bind(id, pinned ? 1 : 0)
			.run();
	}

	async remove(id: string): Promise<void> {
		await this.db
			.prepare(`DELETE FROM conversation_notes WHERE id = ?1`)
			.bind(id)
			.run();
	}
}
