/**
 * Where satisfaction surveys are kept, and how an answer is caught.
 *
 * The rules are `csat.ts` and are pure. This file reads the inputs those rules
 * need, records what was sent and what came back, and produces the figures.
 *
 * **"Resolved" is the conversation's status, timed by its last update.** The
 * conversations table has no resolved_at column, so a resolved conversation's
 * `updated_at` stands in for when it was resolved. That is close but not
 * exact — a later status touch would move it — and it only affects whether a
 * survey is sent, never the score. A dedicated column is the better answer if
 * this matters later.
 *
 * **Sending is off unless switched on.** `CSAT_SURVEYS_ENABLED` defaults to
 * anything but "true", in which case nothing is ever sent — the same posture as
 * broadcasts. A survey is ABC Cargo choosing to message a customer who did not
 * ask to be messaged, and turning that on is a decision, not a deploy.
 */

import type {
	CsatRecord,
	SurveyChannel,
	SurveyEligibilityInput,
} from "./csat.ts";

export interface SurveyRow {
	conversation_id: string;
	customer_id: string | null;
	wa_id: string;
	region_id: string;
	agent_id: string | null;
	channel: SurveyChannel;
	sent_at: string;
	responded_at: string | null;
	score: number | null;
	comment: string | null;
}

export class CsatStore {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	/**
	 * Everything `shouldSendSurvey` needs for one conversation, or null when
	 * the conversation does not exist.
	 */
	async eligibility(
		conversationId: string,
		templateAvailable: boolean,
	): Promise<SurveyEligibilityInput | null> {
		const convo = await this.db
			.prepare(
				`SELECT c.id, c.wa_id, c.status, c.updated_at, c.window_expires_at,
				        COALESCE(k.opted_out, 0) AS opted_out
				   FROM conversations c
				   LEFT JOIN contacts k ON k.wa_id = c.wa_id
				  WHERE c.id = ?1`,
			)
			.bind(conversationId)
			.first<{
				id: string;
				wa_id: string;
				status: string;
				updated_at: string;
				window_expires_at: string | null;
				opted_out: number;
			}>();
		if (!convo) return null;

		const [already, last] = await Promise.all([
			this.db
				.prepare(`SELECT 1 AS x FROM csat_surveys WHERE conversation_id = ?1`)
				.bind(conversationId)
				.first<{ x: number }>(),
			this.db
				.prepare(
					`SELECT sent_at FROM csat_surveys WHERE wa_id = ?1
					  ORDER BY sent_at DESC LIMIT 1`,
				)
				.bind(convo.wa_id)
				.first<{ sent_at: string }>(),
		]);

		return {
			conversationId: convo.id,
			customerId: convo.wa_id,
			resolvedAt: convo.status === "resolved" ? convo.updated_at : null,
			alreadySurveyed: !!already,
			lastSurveyedCustomerAt: last?.sent_at ?? null,
			optedOut: convo.opted_out === 1,
			windowExpiresAt: convo.window_expires_at,
			templateAvailable,
			hasPhone: !!convo.wa_id,
		};
	}

	/**
	 * Records that a survey was sent.
	 *
	 * Returns false when one already exists for the conversation. The primary
	 * key refuses the second insert, so two sweeps racing on the same
	 * conversation cannot both send — whichever records first wins, and the
	 * other is told not to.
	 */
	async recordSent(input: {
		conversationId: string;
		customerId: string | null;
		waId: string;
		regionId: string;
		agentId: string | null;
		channel: SurveyChannel;
		sentAt: string;
	}): Promise<boolean> {
		const result = await this.db
			.prepare(
				`INSERT INTO csat_surveys
				   (conversation_id, customer_id, wa_id, region_id, agent_id, channel, sent_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
				 ON CONFLICT(conversation_id) DO NOTHING`,
			)
			.bind(
				input.conversationId,
				input.customerId,
				input.waId,
				input.regionId,
				input.agentId,
				input.channel,
				input.sentAt,
			)
			.run();
		return (result.meta?.changes ?? 0) > 0;
	}

	/**
	 * Removes a survey claim whose message never went out. Only an unanswered
	 * one: an answer is the customer's, and is never deleted by a retry path.
	 */
	async withdrawUnanswered(conversationId: string): Promise<void> {
		await this.db
			.prepare(
				`DELETE FROM csat_surveys
				  WHERE conversation_id = ?1 AND responded_at IS NULL`,
			)
			.bind(conversationId)
			.run();
	}

	/** The survey awaiting an answer on this conversation, if any. */
	async openSurvey(conversationId: string): Promise<SurveyRow | null> {
		return this.db
			.prepare(
				`SELECT * FROM csat_surveys
				  WHERE conversation_id = ?1 AND responded_at IS NULL`,
			)
			.bind(conversationId)
			.first<SurveyRow>();
	}

	/**
	 * Records an answer. Only the first answer counts.
	 *
	 * The `responded_at IS NULL` guard makes a duplicate webhook, or a customer
	 * who sends "5" and then "4", record once rather than overwrite: the first
	 * answer is the one they gave when asked.
	 */
	async recordResponse(input: {
		conversationId: string;
		score: number;
		comment: string | null;
		respondedAt: string;
	}): Promise<boolean> {
		const result = await this.db
			.prepare(
				`UPDATE csat_surveys
				    SET score = ?2, comment = ?3, responded_at = ?4
				  WHERE conversation_id = ?1 AND responded_at IS NULL`,
			)
			.bind(input.conversationId, input.score, input.comment, input.respondedAt)
			.run();
		return (result.meta?.changes ?? 0) > 0;
	}

	/** Answers in a window, optionally limited to some regions. */
	async responses(input: {
		from: string;
		to: string;
		regionIds: string[] | null;
	}): Promise<CsatRecord[]> {
		const rows = await this.db
			.prepare(
				`SELECT score, region_id, agent_id, responded_at FROM csat_surveys
				  WHERE responded_at IS NOT NULL AND score IS NOT NULL
				    AND responded_at >= ?1 AND responded_at <= ?2`,
			)
			.bind(input.from, input.to)
			.all<{
				score: number;
				region_id: string;
				agent_id: string | null;
				responded_at: string;
			}>();
		return (rows.results ?? [])
			.filter(
				(r) =>
					input.regionIds === null || input.regionIds.includes(r.region_id),
			)
			.map((r) => ({
				score: r.score,
				regionId: r.region_id,
				agentId: r.agent_id,
				respondedAt: r.responded_at,
			}));
	}

	/** Surveys sent in a window, per region. */
	async sentByRegion(input: {
		from: string;
		to: string;
		regionIds: string[] | null;
	}): Promise<Record<string, number>> {
		const rows = await this.db
			.prepare(
				`SELECT region_id, COUNT(*) AS n FROM csat_surveys
				  WHERE sent_at >= ?1 AND sent_at <= ?2
				  GROUP BY region_id`,
			)
			.bind(input.from, input.to)
			.all<{ region_id: string; n: number }>();
		const out: Record<string, number> = {};
		for (const r of rows.results ?? []) {
			if (input.regionIds === null || input.regionIds.includes(r.region_id)) {
				out[r.region_id] = r.n;
			}
		}
		return out;
	}
}
