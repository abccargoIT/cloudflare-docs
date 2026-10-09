/**
 * The scheduled pass that asks resolved conversations for a score.
 *
 * Off unless `CSAT_SURVEYS_ENABLED` is exactly "true". With it off this does
 * not read the database at all.
 *
 * What it sends, and when:
 *
 * - **After resolution, not at it.** A conversation is asked once it has
 *   stayed resolved for `SURVEY_DELAY_MINUTES`. An agent who resolves and
 *   then remembers one more thing reopens it, and the customer is not asked
 *   to rate a conversation that is still going.
 * - **Inside the service window only, for now.** Outside the 24-hour window
 *   WhatsApp allows only an approved template, and no survey template has
 *   been approved. So a conversation resolved after its window closed is not
 *   surveyed. When a template is approved, `templateAvailable` and a template
 *   send path are the change.
 * - **Claimed before sent.** The survey row is written first, and the
 *   primary key refuses a second, so two overlapping passes cannot both ask.
 *   If the send then fails the claim is withdrawn, so the response rate is
 *   not divided by surveys nobody received.
 *
 * The SQL below narrows the candidates; `shouldSendSurvey` still makes the
 * decision for each one, so the rule lives in one tested place.
 */

import type { Env } from "../env.ts";
import { CsatStore } from "./csat-store.ts";
import { SURVEY_COOLDOWN_DAYS, shouldSendSurvey } from "./csat.ts";

/** How long a conversation must stay resolved before it is surveyed. */
export const SURVEY_DELAY_MINUTES = 10;

/** Resolved conversations older than this are not surveyed late. */
export const SURVEY_LOOKBACK_HOURS = 24;

/** Surveys sent per pass. The cron runs every minute. */
export const SURVEY_BATCH = 25;

/**
 * The question.
 *
 * A draft for ABC Cargo to approve before sending is switched on — not
 * approved wording. Buttons would be better than a typed number, and the
 * parser already accepts both.
 */
export const SURVEY_TEXT =
	"Thank you for contacting ABC Cargo. How would you rate the help you received today? " +
	"Please reply with a number from 1 (poor) to 5 (excellent), and add a comment if you wish.";

export function surveysEnabled(
	env: Pick<Env, "CSAT_SURVEYS_ENABLED">,
): boolean {
	return env.CSAT_SURVEYS_ENABLED === "true";
}

export interface SurveyPass {
	enabled: boolean;
	considered: number;
	sent: number;
	skipped: number;
	failed: number;
}

export async function runSurveySweep(
	env: Env,
	now: Date = new Date(),
): Promise<SurveyPass> {
	const pass: SurveyPass = {
		enabled: surveysEnabled(env),
		considered: 0,
		sent: 0,
		skipped: 0,
		failed: 0,
	};
	if (!pass.enabled) return pass;

	const nowMs = now.getTime();
	const resolvedBefore = new Date(
		nowMs - SURVEY_DELAY_MINUTES * 60_000,
	).toISOString();
	const resolvedAfter = new Date(
		nowMs - SURVEY_LOOKBACK_HOURS * 3_600_000,
	).toISOString();
	const cooldownFrom = new Date(
		nowMs - SURVEY_COOLDOWN_DAYS * 86_400_000,
	).toISOString();

	const { results } = await env.DB.prepare(
		`SELECT c.id, c.wa_id, c.region_id, c.assigned_agent_id
		   FROM conversations c
		  WHERE c.status = 'resolved'
		    AND c.updated_at >= ?1 AND c.updated_at <= ?2
		    AND c.window_expires_at > ?3
		    AND NOT EXISTS (SELECT 1 FROM csat_surveys s WHERE s.conversation_id = c.id)
		    AND NOT EXISTS (SELECT 1 FROM csat_surveys s
		                     WHERE s.wa_id = c.wa_id AND s.sent_at >= ?4)
		    AND NOT EXISTS (SELECT 1 FROM contacts k
		                     WHERE k.wa_id = c.wa_id AND k.opted_out = 1)
		  ORDER BY c.updated_at ASC
		  LIMIT ?5`,
	)
		.bind(
			resolvedAfter,
			resolvedBefore,
			now.toISOString(),
			cooldownFrom,
			SURVEY_BATCH,
		)
		.all<{
			id: string;
			wa_id: string;
			region_id: string;
			assigned_agent_id: string | null;
		}>();

	const store = new CsatStore(env.DB);
	for (const row of results ?? []) {
		pass.considered++;
		// No approved template yet: see the file comment.
		const eligibility = await store.eligibility(row.id, false);
		const decision = eligibility ? shouldSendSurvey(eligibility, now) : null;
		if (!decision?.send) {
			pass.skipped++;
			continue;
		}

		const claimed = await store.recordSent({
			conversationId: row.id,
			customerId: null,
			waId: row.wa_id,
			regionId: row.region_id,
			agentId: row.assigned_agent_id,
			channel: decision.channel,
			sentAt: now.toISOString(),
		});
		if (!claimed) {
			pass.skipped++;
			continue;
		}

		try {
			const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(row.id));
			await stub.sendSurveyText(SURVEY_TEXT);
			pass.sent++;
		} catch (error) {
			pass.failed++;
			await store.withdrawUnanswered(row.id);
			console.error("survey not sent; claim withdrawn", {
				conversationId: row.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return pass;
}
