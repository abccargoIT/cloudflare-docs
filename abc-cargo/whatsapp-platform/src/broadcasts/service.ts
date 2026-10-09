/**
 * Storage and lifecycle for broadcasts.
 *
 * The important behaviour here is what happens when things are done out of
 * order or twice, because that is what actually happens: somebody presses Send
 * twice, a queue batch is retried, a status webhook arrives late, two people
 * edit the same campaign. Each of those is handled by the database rather than
 * by hoping.
 */

import { compileAudience, type AudienceRule } from "./audience.ts";
import { voidsApproval } from "./policy.ts";
import {
	advances,
	type BroadcastKind,
	type BroadcastProgress,
	type BroadcastRow,
	type BroadcastStatus,
	type RecipientRow,
	type RecipientState,
	type SkipReason,
	REPLY_ATTRIBUTION_HOURS,
} from "./types.ts";

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

export type ResolveResult =
	| {
			ok: true;
			/** Everyone who will be messaged. */
			audience: number;
			/** Written down with a reason, not dropped. */
			skipped: number;
			skips: Record<string, number>;
	  }
	| { ok: false; reason: "unreadable_audience"; message: string };

export class BroadcastService {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	/* --------------------------------------------------------- the record */

	async get(id: string): Promise<BroadcastRow | null> {
		return this.db
			.prepare(`SELECT * FROM broadcasts WHERE id = ?1`)
			.bind(id)
			.first<BroadcastRow>();
	}

	async list(regionIds: string[], limit = 50): Promise<BroadcastRow[]> {
		if (regionIds.length === 0) return [];
		const placeholders = regionIds.map((_, i) => `?${i + 1}`).join(", ");
		const { results } = await this.db
			.prepare(
				`SELECT * FROM broadcasts WHERE region_id IN (${placeholders})
				 ORDER BY created_at DESC LIMIT ?${regionIds.length + 1}`,
			)
			.bind(...regionIds, Math.min(Math.max(limit, 1), 200))
			.all<BroadcastRow>();
		return results ?? [];
	}

	async create(input: {
		regionId: string;
		name: string;
		kind: BroadcastKind;
		templateName: string;
		languageCode: string;
		components?: unknown;
		audience: AudienceRule;
		ratePerMinute?: number;
		createdBy: string;
		now?: Date;
	}): Promise<BroadcastRow> {
		const nowIso = (input.now ?? new Date()).toISOString();
		const id = newId("bc");
		await this.db
			.prepare(
				`INSERT INTO broadcasts
				   (id, region_id, name, kind, template_name, language_code,
				    components, audience, status, rate_per_minute,
				    created_by, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'draft', ?9, ?10, ?11, ?11)`,
			)
			.bind(
				id,
				input.regionId,
				input.name.trim(),
				input.kind,
				input.templateName.trim(),
				input.languageCode.trim(),
				input.components === undefined
					? null
					: JSON.stringify(input.components),
				JSON.stringify(input.audience),
				clampRate(input.ratePerMinute),
				input.createdBy,
				nowIso,
			)
			.run();
		const created = await this.get(id);
		if (!created) throw new Error("failed to create the broadcast");
		return created;
	}

	/**
	 * Edits a draft, and sends it back to draft if the change matters.
	 *
	 * A change to who is messaged or what they are told voids the approval,
	 * because otherwise the thing a second person read is not the thing that
	 * goes out.
	 */
	async update(input: {
		id: string;
		changes: {
			name?: string;
			kind?: BroadcastKind;
			templateName?: string;
			languageCode?: string;
			components?: unknown;
			audience?: AudienceRule;
			ratePerMinute?: number;
		};
		now?: Date;
	}): Promise<{ broadcast: BroadcastRow; approvalVoided: boolean }> {
		const nowIso = (input.now ?? new Date()).toISOString();
		const changed = Object.keys(input.changes).filter(
			(key) => input.changes[key as keyof typeof input.changes] !== undefined,
		);
		const approvalVoided = voidsApproval(changed);

		await this.db
			.prepare(
				`UPDATE broadcasts SET
				   name = COALESCE(?2, name),
				   kind = COALESCE(?3, kind),
				   template_name = COALESCE(?4, template_name),
				   language_code = COALESCE(?5, language_code),
				   components = CASE WHEN ?6 = 1 THEN ?7 ELSE components END,
				   audience = COALESCE(?8, audience),
				   rate_per_minute = COALESCE(?9, rate_per_minute),
				   status = CASE WHEN ?10 = 1 THEN 'draft' ELSE status END,
				   approved_by = CASE WHEN ?10 = 1 THEN NULL ELSE approved_by END,
				   approved_at = CASE WHEN ?10 = 1 THEN NULL ELSE approved_at END,
				   -- A changed audience is no longer the one that was resolved.
				   resolved_at = CASE WHEN ?11 = 1 THEN NULL ELSE resolved_at END,
				   resolved_count = CASE WHEN ?11 = 1 THEN NULL ELSE resolved_count END,
				   updated_at = ?12
				 WHERE id = ?1`,
			)
			.bind(
				input.id,
				input.changes.name?.trim() ?? null,
				input.changes.kind ?? null,
				input.changes.templateName?.trim() ?? null,
				input.changes.languageCode?.trim() ?? null,
				input.changes.components === undefined ? 0 : 1,
				input.changes.components === undefined
					? null
					: JSON.stringify(input.changes.components),
				input.changes.audience === undefined
					? null
					: JSON.stringify(input.changes.audience),
				input.changes.ratePerMinute === undefined
					? null
					: clampRate(input.changes.ratePerMinute),
				approvalVoided ? 1 : 0,
				input.changes.audience === undefined ? 0 : 1,
				nowIso,
			)
			.run();

		const broadcast = await this.get(input.id);
		if (!broadcast) throw new Error("the broadcast disappeared during update");
		return { broadcast, approvalVoided };
	}

	/* ------------------------------------------------- freezing the audience */

	/**
	 * Writes down exactly who will be messaged.
	 *
	 * The candidate query already excludes anyone who has opted out and anyone
	 * with no WhatsApp id, so those never appear as recipients at all. What is
	 * written down as skipped is the marketing opt-in: a customer who is in the
	 * audience by every other measure but has not agreed to marketing is
	 * recorded, with the reason, so "4,812 of 5,000" has an answer.
	 *
	 * Replaces any previous resolution. Only reachable before the first message
	 * goes out — `canResolveAudience` is the guard, and the reason is that
	 * reconciling a new list against people already messaged either messages
	 * somebody twice or drops them silently.
	 */
	async resolveAudience(input: {
		broadcast: BroadcastRow;
		now?: Date;
	}): Promise<ResolveResult> {
		const now = input.now ?? new Date();
		const nowIso = now.toISOString();
		const rule = parseAudience(input.broadcast.audience);
		if (rule === null) {
			// Refused rather than defaulted. An empty rule is not "nobody" —
			// every field is a narrowing filter, so it would mean every
			// customer in the region.
			return {
				ok: false,
				reason: "unreadable_audience",
				message:
					"the stored audience rule could not be read; nothing was resolved",
			};
		}
		const marketing = input.broadcast.kind === "marketing";

		// Everyone the filters reach, ignoring the marketing opt-in, so that a
		// customer excluded only by the opt-in is recorded rather than
		// invisible. The opt-out and the missing-number exclusions are not
		// optional and are applied inside the compiler.
		const candidates = compileAudience({
			regionId: input.broadcast.region_id,
			rule,
			optedInOnly: false,
			now,
		});
		const { results } = await this.db
			.prepare(
				`SELECT q.wa_id AS wa_id, q.customer_id AS customer_id,
				        COALESCE(c.opt_in_marketing, 0) AS opted_in
				 FROM (${candidates.sql}) q
				 JOIN customers c ON c.id = q.customer_id`,
			)
			.bind(...candidates.bindings)
			.all<{ wa_id: string; customer_id: string; opted_in: number }>();

		const rows = results ?? [];

		await this.db
			.prepare(`DELETE FROM broadcast_recipients WHERE broadcast_id = ?1`)
			.bind(input.broadcast.id)
			.run();

		const skips: Record<string, number> = {};
		let audience = 0;
		let skipped = 0;
		const statements = [];

		for (const row of rows) {
			const skipReason: SkipReason | null =
				marketing && row.opted_in !== 1 ? "not_opted_in" : null;
			if (skipReason) {
				skipped++;
				skips[skipReason] = (skips[skipReason] ?? 0) + 1;
			} else {
				audience++;
			}
			statements.push(
				this.db
					.prepare(
						`INSERT INTO broadcast_recipients
						   (broadcast_id, wa_id, customer_id, region_id, state, skip_reason)
						 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
						 ON CONFLICT (broadcast_id, wa_id) DO NOTHING`,
					)
					.bind(
						input.broadcast.id,
						row.wa_id,
						row.customer_id,
						input.broadcast.region_id,
						skipReason ? "skipped" : "pending",
						skipReason,
					),
			);
		}

		// Written in chunks: D1 takes a bounded batch, and a campaign-sized
		// audience is well past it.
		for (let i = 0; i < statements.length; i += 50) {
			await this.db.batch(statements.slice(i, i + 50));
		}

		await this.db
			.prepare(
				`UPDATE broadcasts SET resolved_at = ?2, resolved_count = ?3,
				        status = CASE WHEN status = 'approved' THEN 'draft' ELSE status END,
				        approved_by = NULL, approved_at = NULL, updated_at = ?2
				 WHERE id = ?1`,
			)
			.bind(input.broadcast.id, nowIso, audience)
			.run();

		return { ok: true, audience, skipped, skips };
	}

	/* --------------------------------------------------------- the lifecycle */

	async setStatus(input: {
		id: string;
		status: BroadcastStatus;
		actor: string;
		reason?: string;
		now?: Date;
	}): Promise<BroadcastRow> {
		const nowIso = (input.now ?? new Date()).toISOString();
		const sets: string[] = [`status = ?2`, `updated_at = ?3`];
		const bindings: (string | number | null)[] = [
			input.id,
			input.status,
			nowIso,
		];

		if (input.status === "cancelled") {
			sets.push(`cancelled_by = ?4`, `cancelled_at = ?3`, `cancel_reason = ?5`);
			bindings.push(input.actor, input.reason ?? null);
		} else if (input.status === "sending") {
			// Only the first start is recorded; a resume must not rewrite it.
			sets.push(`started_at = COALESCE(started_at, ?3)`);
		} else if (input.status === "sent") {
			sets.push(`finished_at = ?3`);
		}

		await this.db
			.prepare(`UPDATE broadcasts SET ${sets.join(", ")} WHERE id = ?1`)
			.bind(...bindings)
			.run();

		const row = await this.get(input.id);
		if (!row) throw new Error("the broadcast disappeared");
		return row;
	}

	async approve(input: {
		id: string;
		approvedBy: string;
		now?: Date;
	}): Promise<BroadcastRow> {
		const nowIso = (input.now ?? new Date()).toISOString();
		await this.db
			.prepare(
				`UPDATE broadcasts SET status = 'approved', approved_by = ?2,
				        approved_at = ?3, updated_at = ?3
				 WHERE id = ?1 AND status = 'review'`,
			)
			.bind(input.id, input.approvedBy, nowIso)
			.run();
		const row = await this.get(input.id);
		if (!row) throw new Error("the broadcast disappeared");
		return row;
	}

	/* ------------------------------------------------------------ recipients */

	async progress(broadcastId: string): Promise<BroadcastProgress> {
		const [states, reasons] = await this.db.batch<{
			k: string | null;
			n: number;
		}>([
			this.db
				.prepare(
					`SELECT state AS k, COUNT(*) AS n FROM broadcast_recipients
					 WHERE broadcast_id = ?1 GROUP BY state`,
				)
				.bind(broadcastId),
			this.db
				.prepare(
					`SELECT skip_reason AS k, COUNT(*) AS n FROM broadcast_recipients
					 WHERE broadcast_id = ?1 AND state = 'skipped'
					 GROUP BY skip_reason`,
				)
				.bind(broadcastId),
		]);

		const by = new Map(
			(states?.results ?? []).map((row) => [row.k ?? "", row.n]),
		);
		const count = (state: RecipientState) => by.get(state) ?? 0;
		const skips: Record<string, number> = {};
		for (const row of reasons?.results ?? []) {
			if (row.k) skips[row.k] = row.n;
		}

		// Delivered, read and replied are later states of a sent message, so a
		// "sent" total that excluded them would fall as delivery progressed.
		const sent =
			count("sent") + count("delivered") + count("read") + count("replied");
		return {
			audience: count("pending") + count("sending") + sent + count("failed"),
			pending: count("pending") + count("sending"),
			skipped: count("skipped"),
			sent,
			delivered: count("delivered") + count("read") + count("replied"),
			read: count("read") + count("replied"),
			replied: count("replied"),
			failed: count("failed"),
			skips,
		};
	}

	async recipients(
		broadcastId: string,
		options: { state?: RecipientState; limit?: number } = {},
	): Promise<RecipientRow[]> {
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
		const { results } = options.state
			? await this.db
					.prepare(
						`SELECT * FROM broadcast_recipients
						 WHERE broadcast_id = ?1 AND state = ?2
						 ORDER BY wa_id LIMIT ?3`,
					)
					.bind(broadcastId, options.state, limit)
					.all<RecipientRow>()
			: await this.db
					.prepare(
						`SELECT * FROM broadcast_recipients WHERE broadcast_id = ?1
						 ORDER BY wa_id LIMIT ?2`,
					)
					.bind(broadcastId, limit)
					.all<RecipientRow>();
		return results ?? [];
	}

	/**
	 * Claims the next few recipients to send to.
	 *
	 * The claim is the point. Moving a row to `sending` in the same statement
	 * that selects it means two concurrent workers, or a retried queue batch,
	 * cannot both pick up the same recipient — and the primary key on
	 * (broadcast_id, wa_id) means that even if they did, only one message could
	 * ever be recorded against that number.
	 */
	async claimBatch(input: {
		broadcastId: string;
		size: number;
		now?: Date;
	}): Promise<RecipientRow[]> {
		const nowIso = (input.now ?? new Date()).toISOString();
		const size = Math.min(Math.max(input.size, 1), 100);
		const { results } = await this.db
			.prepare(
				`UPDATE broadcast_recipients
				 SET state = 'sending', queued_at = ?3, attempts = attempts + 1
				 WHERE broadcast_id = ?1 AND wa_id IN (
				   SELECT wa_id FROM broadcast_recipients
				   WHERE broadcast_id = ?1 AND state = 'pending'
				   ORDER BY wa_id LIMIT ?2
				 )
				 RETURNING *`,
			)
			.bind(input.broadcastId, size, nowIso)
			.all<RecipientRow>();
		return results ?? [];
	}

	/** Whether any of these numbers has opted out since the list was drawn up. */
	async optedOutAmong(waIds: string[]): Promise<Set<string>> {
		if (waIds.length === 0) return new Set();
		const out = new Set<string>();
		for (let i = 0; i < waIds.length; i += 80) {
			const chunk = waIds.slice(i, i + 80);
			const placeholders = chunk.map((_, j) => `?${j + 1}`).join(", ");
			const { results } = await this.db
				.prepare(
					`SELECT wa_id FROM contacts
					 WHERE opted_out = 1 AND wa_id IN (${placeholders})`,
				)
				.bind(...chunk)
				.all<{ wa_id: string }>();
			for (const row of results ?? []) out.add(row.wa_id);
		}
		return out;
	}

	async markSent(input: {
		broadcastId: string;
		waId: string;
		conversationId: string;
		waMessageId: string;
		now?: Date;
	}): Promise<void> {
		const nowIso = (input.now ?? new Date()).toISOString();
		await this.db
			.prepare(
				`UPDATE broadcast_recipients
				 SET state = 'sent', conversation_id = ?3, wa_message_id = ?4,
				     sent_at = ?5, error_code = NULL, error_message = NULL
				 WHERE broadcast_id = ?1 AND wa_id = ?2`,
			)
			.bind(
				input.broadcastId,
				input.waId,
				input.conversationId,
				input.waMessageId,
				nowIso,
			)
			.run();
	}

	async markSkipped(input: {
		broadcastId: string;
		waId: string;
		reason: SkipReason;
	}): Promise<void> {
		await this.db
			.prepare(
				`UPDATE broadcast_recipients
				 SET state = 'skipped', skip_reason = ?3
				 WHERE broadcast_id = ?1 AND wa_id = ?2`,
			)
			.bind(input.broadcastId, input.waId, input.reason)
			.run();
	}

	async markFailed(input: {
		broadcastId: string;
		waId: string;
		code?: number | null;
		message: string;
	}): Promise<void> {
		await this.db
			.prepare(
				`UPDATE broadcast_recipients
				 SET state = 'failed', error_code = ?3, error_message = ?4
				 WHERE broadcast_id = ?1 AND wa_id = ?2`,
			)
			.bind(
				input.broadcastId,
				input.waId,
				input.code ?? null,
				input.message.slice(0, 500),
			)
			.run();
	}

	/**
	 * Records a delivery status that arrived from Meta.
	 *
	 * Forward only. WhatsApp does not promise the order these arrive in, and a
	 * late `delivered` after a `read` must not move the recipient backwards —
	 * which would make a campaign's read figure fall as more statuses came in.
	 */
	async recordDeliveryStatus(input: {
		waMessageId: string;
		status: "delivered" | "read";
		now?: Date;
	}): Promise<boolean> {
		const nowIso = (input.now ?? new Date()).toISOString();
		const current = await this.db
			.prepare(
				`SELECT broadcast_id, wa_id, state FROM broadcast_recipients
				 WHERE wa_message_id = ?1`,
			)
			.bind(input.waMessageId)
			.first<{ broadcast_id: string; wa_id: string; state: string }>();
		if (!current) return false;
		if (!advances(current.state as RecipientState, input.status)) return false;

		const column = input.status === "delivered" ? "delivered_at" : "read_at";
		await this.db
			.prepare(
				`UPDATE broadcast_recipients SET state = ?3, ${column} = ?4
				 WHERE broadcast_id = ?1 AND wa_id = ?2`,
			)
			.bind(current.broadcast_id, current.wa_id, input.status, nowIso)
			.run();
		return true;
	}

	/**
	 * Credits a reply to a broadcast, if one is recent enough to have caused it.
	 *
	 * Three days. A customer answering a week later is answering something
	 * else, and a campaign that claims every conversation that follows it makes
	 * its own figures worthless.
	 */
	async recordReply(input: {
		conversationId: string;
		now?: Date;
	}): Promise<boolean> {
		const now = input.now ?? new Date();
		const nowIso = now.toISOString();
		const cutoff = new Date(
			now.getTime() - REPLY_ATTRIBUTION_HOURS * 3_600_000,
		).toISOString();

		const candidate = await this.db
			.prepare(
				`SELECT broadcast_id, wa_id, state FROM broadcast_recipients
				 WHERE conversation_id = ?1 AND sent_at >= ?2
				   AND replied_at IS NULL
				 ORDER BY sent_at DESC LIMIT 1`,
			)
			.bind(input.conversationId, cutoff)
			.first<{ broadcast_id: string; wa_id: string; state: string }>();
		if (!candidate) return false;
		if (!advances(candidate.state as RecipientState, "replied")) return false;

		await this.db
			.prepare(
				`UPDATE broadcast_recipients SET state = 'replied', replied_at = ?3
				 WHERE broadcast_id = ?1 AND wa_id = ?2`,
			)
			.bind(candidate.broadcast_id, candidate.wa_id, nowIso)
			.run();
		return true;
	}

	/** Whether anything is left to send. */
	async pendingCount(broadcastId: string): Promise<number> {
		const row = await this.db
			.prepare(
				`SELECT COUNT(*) AS n FROM broadcast_recipients
				 WHERE broadcast_id = ?1 AND state IN ('pending','sending')`,
			)
			.bind(broadcastId)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	/** Every broadcast currently mid-send, which is what the pacer looks for. */
	async sendingBroadcasts(): Promise<BroadcastRow[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM broadcasts WHERE status = 'sending'`)
			.all<BroadcastRow>();
		return results ?? [];
	}
}

/** Rate limiting is about protecting the number, so the bounds are narrow. */
export function clampRate(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 20;
	return Math.min(Math.max(Math.floor(value), 1), 120);
}

/**
 * Reads a stored audience rule, or returns null.
 *
 * Null rather than a default. There is no safe default here: an empty rule is
 * not "nobody", it is "every customer in the region with a WhatsApp number",
 * because every field is a narrowing filter. A broadcast whose audience cannot
 * be read must refuse to resolve, and the caller is required to handle that
 * rather than being handed something that looks usable.
 */
export function parseAudience(json: string): AudienceRule | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	return parsed as AudienceRule;
}
