/**
 * Storage for flows and sessions.
 *
 * The rule this file exists to hold: a published flow is never rewritten.
 * Editing one produces the next version as a draft, and publishing that draft
 * retires the one before it. A session records the version it started on, so
 * the version it started on has to still be there when the next message
 * arrives — otherwise publishing a change mid-conversation moves a customer
 * who is halfway through answering a question into a different flow.
 */

import { parseSteps } from "./parse.ts";
import type {
	BotFlow,
	BotSession,
	BotTrace,
	FlowStatus,
	SessionEndReason,
} from "./types.ts";
import { validateFlow, type FlowProblem } from "./validate.ts";

export interface FlowRow {
	id: string;
	region_id: string;
	name: string;
	version: number;
	status: string;
	entry_step_id: string;
	steps: string;
	created_by: string | null;
	created_at: string;
	updated_at: string;
	published_at: string | null;
	published_by: string | null;
}

export interface SessionRow {
	conversation_id: string;
	customer_id: string | null;
	region_id: string;
	flow_id: string;
	flow_version: number;
	step_id: string | null;
	slots: string;
	invalid_replies: number;
	turns: number;
	started_at: string;
	updated_at: string;
	ended_at: string | null;
	ended_reason: string | null;
}

export type FlowLoad =
	{ ok: true; flow: BotFlow } | { ok: false; problems: FlowProblem[] };

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

export class BotService {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	/* -------------------------------------------------------------- flows */

	/** Every version for a region, newest first, without the step documents. */
	async listFlows(regionId: string): Promise<Omit<FlowRow, "steps">[]> {
		const { results } = await this.db
			.prepare(
				`SELECT id, region_id, name, version, status, entry_step_id,
				        created_by, created_at, updated_at, published_at, published_by
				 FROM bot_flows WHERE region_id = ?1 ORDER BY version DESC`,
			)
			.bind(regionId)
			.all<Omit<FlowRow, "steps">>();
		return results ?? [];
	}

	async getFlowRow(id: string): Promise<FlowRow | null> {
		return this.db
			.prepare(`SELECT * FROM bot_flows WHERE id = ?1`)
			.bind(id)
			.first<FlowRow>();
	}

	/** The flow a customer of this region meets right now, if there is one. */
	async publishedFlow(regionId: string): Promise<FlowLoad | null> {
		const row = await this.db
			.prepare(
				`SELECT * FROM bot_flows WHERE region_id = ?1 AND status = 'published'`,
			)
			.bind(regionId)
			.first<FlowRow>();
		return row ? toFlow(row) : null;
	}

	/**
	 * A specific version, which is what resuming a session needs.
	 *
	 * Looked up by region and version rather than by flow id so a session
	 * survives a flow row being replaced, which is the situation this whole
	 * versioning scheme is for.
	 */
	async flowVersion(
		regionId: string,
		version: number,
	): Promise<FlowLoad | null> {
		const row = await this.db
			.prepare(`SELECT * FROM bot_flows WHERE region_id = ?1 AND version = ?2`)
			.bind(regionId, version)
			.first<FlowRow>();
		return row ? toFlow(row) : null;
	}

	/** The highest version held for a region, published, draft or retired. */
	async latestVersion(regionId: string): Promise<number> {
		const row = await this.db
			.prepare(`SELECT MAX(version) AS v FROM bot_flows WHERE region_id = ?1`)
			.bind(regionId)
			.first<{ v: number | null }>();
		return row?.v ?? 0;
	}

	/**
	 * Saves a draft as the next version. Never touches an existing one.
	 *
	 * The draft is validated and the problems are returned either way: a draft
	 * is allowed to be broken, because half-finished work has to be saveable,
	 * and publishing is where the refusal belongs.
	 */
	async saveDraft(input: {
		regionId: string;
		name: string;
		entryStepId: string;
		steps: unknown;
		author?: string | null;
		now?: Date;
	}): Promise<{ flow: FlowRow; problems: FlowProblem[] }> {
		const nowIso = (input.now ?? new Date()).toISOString();
		const version = (await this.latestVersion(input.regionId)) + 1;
		const parsed = parseSteps(input.steps);
		const id = newId("flow");

		await this.db
			.prepare(
				`INSERT INTO bot_flows
				   (id, region_id, name, version, status, entry_step_id, steps,
				    created_by, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?6, ?7, ?8, ?8)`,
			)
			.bind(
				id,
				input.regionId,
				input.name.trim(),
				version,
				input.entryStepId,
				JSON.stringify(parsed.steps),
				input.author ?? null,
				nowIso,
			)
			.run();

		const flow = await this.getFlowRow(id);
		if (!flow) throw new Error("failed to save the draft");

		const problems = [
			...parsed.problems,
			...validateFlow({
				id,
				regionId: input.regionId,
				name: input.name,
				version,
				status: "draft",
				entryStepId: input.entryStepId,
				steps: parsed.steps,
			}).problems,
		];
		return { flow, problems };
	}

	/**
	 * Publishes a draft, if it passes validation.
	 *
	 * The retire and the publish go in one batch. Halfway through — the old one
	 * retired, the new one not yet published — is a region with no bot, and on
	 * a live number that is silence.
	 */
	async publish(input: {
		flowId: string;
		actor?: string | null;
		now?: Date;
	}): Promise<
		| {
				ok: false;
				reason: "not_found" | "not_a_draft" | "invalid";
				problems: FlowProblem[];
		  }
		| { ok: true; flow: FlowRow; problems: FlowProblem[] }
	> {
		const row = await this.getFlowRow(input.flowId);
		if (!row) return { ok: false, reason: "not_found", problems: [] };
		if (row.status !== "draft") {
			return { ok: false, reason: "not_a_draft", problems: [] };
		}

		const loaded = toFlow(row);
		if (!loaded.ok) {
			return { ok: false, reason: "invalid", problems: loaded.problems };
		}
		const checked = validateFlow(loaded.flow);
		if (!checked.ok) {
			return { ok: false, reason: "invalid", problems: checked.problems };
		}

		const nowIso = (input.now ?? new Date()).toISOString();
		await this.db.batch([
			this.db
				.prepare(
					`UPDATE bot_flows SET status = 'retired', updated_at = ?2
					 WHERE region_id = ?1 AND status = 'published'`,
				)
				.bind(row.region_id, nowIso),
			this.db
				.prepare(
					`UPDATE bot_flows SET status = 'published', published_at = ?2,
					        published_by = ?3, updated_at = ?2
					 WHERE id = ?1`,
				)
				.bind(row.id, nowIso, input.actor ?? null),
		]);

		const published = await this.getFlowRow(row.id);
		if (!published) throw new Error("the flow disappeared while publishing");
		// Warnings survive the publish and are worth returning: an unreachable
		// branch is published too, and whoever pressed the button should know.
		return { ok: true, flow: published, problems: checked.problems };
	}

	/**
	 * Takes a region's bot out of service without deleting anything.
	 *
	 * With no published flow the platform falls back to the automated reply and
	 * the ordinary agent queue, which is the behaviour we want if a flow turns
	 * out to be wrong on a live number at two in the morning.
	 */
	async unpublish(regionId: string, now: Date = new Date()): Promise<number> {
		const result = await this.db
			.prepare(
				`UPDATE bot_flows SET status = 'retired', updated_at = ?2
				 WHERE region_id = ?1 AND status = 'published'`,
			)
			.bind(regionId, now.toISOString())
			.run();
		return result.meta.changes ?? 0;
	}

	/* ------------------------------------------------------------ sessions */

	async session(conversationId: string): Promise<BotSession | null> {
		const row = await this.db
			.prepare(`SELECT * FROM bot_sessions WHERE conversation_id = ?1`)
			.bind(conversationId)
			.first<SessionRow>();
		return row ? toSession(row) : null;
	}

	async saveSession(input: {
		conversationId: string;
		customerId?: string | null;
		regionId: string;
		session: BotSession;
	}): Promise<void> {
		const s = input.session;
		await this.db
			.prepare(
				`INSERT INTO bot_sessions
				   (conversation_id, customer_id, region_id, flow_id, flow_version,
				    step_id, slots, invalid_replies, turns, started_at, updated_at,
				    ended_at, ended_reason)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
				 ON CONFLICT (conversation_id) DO UPDATE SET
				   customer_id = COALESCE(excluded.customer_id, customer_id),
				   flow_id = excluded.flow_id,
				   flow_version = excluded.flow_version,
				   step_id = excluded.step_id,
				   slots = excluded.slots,
				   invalid_replies = excluded.invalid_replies,
				   turns = excluded.turns,
				   started_at = excluded.started_at,
				   updated_at = excluded.updated_at,
				   ended_at = excluded.ended_at,
				   ended_reason = excluded.ended_reason`,
			)
			.bind(
				input.conversationId,
				input.customerId ?? null,
				input.regionId,
				s.flowId,
				s.flowVersion,
				s.stepId,
				JSON.stringify(s.slots),
				s.invalidReplies,
				s.turns,
				s.startedAt,
				s.updatedAt,
				s.endedAt,
				s.endedReason,
			)
			.run();
	}

	/** The record of why the bot did what it did, one row per inbound message. */
	async recordTurn(input: {
		conversationId: string;
		regionId: string;
		flowId: string;
		flowVersion: number;
		fromStepId: string | null;
		toStepId: string | null;
		endedReason: SessionEndReason | null;
		trace: BotTrace[];
		now?: Date;
	}): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO bot_turns
				   (id, conversation_id, region_id, flow_id, flow_version,
				    from_step_id, to_step_id, ended_reason, trace, occurred_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
			)
			.bind(
				newId("bturn"),
				input.conversationId,
				input.regionId,
				input.flowId,
				input.flowVersion,
				input.fromStepId,
				input.toStepId,
				input.endedReason,
				JSON.stringify(input.trace),
				(input.now ?? new Date()).toISOString(),
			)
			.run();
	}

	async turnsFor(conversationId: string, limit = 50): Promise<unknown[]> {
		const { results } = await this.db
			.prepare(
				`SELECT * FROM bot_turns WHERE conversation_id = ?1
				 ORDER BY occurred_at DESC LIMIT ?2`,
			)
			.bind(conversationId, Math.min(Math.max(limit, 1), 200))
			.all();
		return results ?? [];
	}
}

/* ------------------------------------------------------------ row mapping */

export function toFlow(row: FlowRow): FlowLoad {
	const parsed = parseSteps(row.steps);
	if (parsed.problems.some((p) => p.severity === "error")) {
		return { ok: false, problems: parsed.problems };
	}
	return {
		ok: true,
		flow: {
			id: row.id,
			regionId: row.region_id,
			name: row.name,
			version: row.version,
			status: row.status as FlowStatus,
			entryStepId: row.entry_step_id,
			steps: parsed.steps,
		},
	};
}

export function toSession(row: SessionRow): BotSession {
	let slots: Record<string, string> = {};
	try {
		const parsed: unknown = JSON.parse(row.slots);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof value === "string") slots[key] = value;
			}
		}
	} catch {
		// An unreadable slot bag loses the answers but not the session. The
		// alternative is throwing, which would stop the customer being
		// answered at all.
		slots = {};
	}
	return {
		flowId: row.flow_id,
		flowVersion: row.flow_version,
		stepId: row.step_id,
		slots,
		invalidReplies: row.invalid_replies,
		turns: row.turns,
		startedAt: row.started_at,
		updatedAt: row.updated_at,
		endedAt: row.ended_at,
		endedReason: (row.ended_reason as SessionEndReason | null) ?? null,
	};
}
