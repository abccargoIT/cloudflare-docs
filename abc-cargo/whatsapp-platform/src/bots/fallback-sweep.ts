/**
 * The scheduled pass that acts on bot sessions nobody is answering.
 *
 * `escalation.ts` decides; this carries the decision out. Two things can
 * happen to a session waiting on the customer:
 *
 * - **Silent past the step's threshold, in business minutes** — the session
 *   ends as a handover, exactly as if the customer had asked for a person, and
 *   the conversation sits in the region's agent queue. The customer is not
 *   sent anything: they have gone quiet, and a message from the bot saying it
 *   has given up on them is noise. The person who picks it up sees the
 *   answers already collected.
 * - **Past the 24-hour session lifetime** — the session ends as `expired`.
 *   Without this, an abandoned session stays "in progress" for ever and the
 *   deflection report can never count it as abandoned, which is the one
 *   number that keeps that report honest.
 *
 * Tier 2 is not acted on. `checkFallback` can describe it, but the platform
 * has no Tier 2 queue to put a conversation in yet, so moving one there would
 * be moving it nowhere. It needs a decision on who Tier 2 is before it is
 * wired.
 *
 * Every write is conditional on the session not having moved since it was
 * read, so a customer who replies while the sweep is running wins.
 */

import type { Env } from "../env.ts";
import {
	findRegionById,
	parseRegionConfig,
	type RegionConfig,
} from "../regions.ts";
import { applyFallback, checkFallback } from "./escalation.ts";
import {
	BotService,
	toSession,
	type FlowLoad,
	type SessionRow,
} from "./service.ts";
import type { BotFlow, BotSession, BotTrace } from "./types.ts";

/** Sessions examined per pass, oldest first. The cron runs every minute. */
export const SWEEP_BATCH = 100;

export type SweepAction =
	| { kind: "none" }
	| {
			kind: "handover" | "expire";
			ended: BotSession;
			trace: BotTrace[];
	  };

/**
 * What to do with one waiting session. Pure, so the rule is testable without
 * a database: the sweep below is only the loop around it.
 */
export function planFallback(input: {
	session: BotSession;
	flow: BotFlow | null;
	region: RegionConfig;
	windowExpiresAt: string | null;
	now: Date;
}): SweepAction {
	const { session, flow, region, now } = input;
	const step =
		flow?.steps.find((candidate) => candidate.id === session.stepId) ?? null;

	const decision = checkFallback({
		session,
		step,
		region,
		windowExpiresAt: input.windowExpiresAt,
		now,
	});
	const nowIso = now.toISOString();
	const stepId = session.stepId ?? "unknown";

	if (decision.reason === "session_expired") {
		return {
			kind: "expire",
			ended: {
				...session,
				stepId: null,
				endedAt: nowIso,
				endedReason: "expired",
				updatedAt: nowIso,
			},
			trace: [
				{
					stepId,
					kind: "timeout",
					note: "no reply within the session lifetime; ended as expired",
				},
			],
		};
	}

	// Only Tier 1 is acted on. See the file comment.
	if (!decision.escalate || decision.tier !== "tier1") return { kind: "none" };

	const applied = applyFallback(session, decision, now);
	return {
		kind: "handover",
		ended: applied.session,
		trace: [
			{
				stepId,
				kind: "timeout",
				note:
					`no reply for ${decision.silentMinutes} business minutes; ` +
					`handed to ${decision.queue ?? "the regional desk"}` +
					(decision.templateOnly
						? " (service window closed: an agent must open with a template)"
						: ""),
			},
		],
	};
}

export interface SweepResult {
	checked: number;
	handedOver: number;
	expired: number;
	/** A customer replied between the read and the write. */
	lostRace: number;
	skipped: number;
}

export async function runFallbackSweep(
	env: Env,
	now: Date = new Date(),
): Promise<SweepResult> {
	const result: SweepResult = {
		checked: 0,
		handedOver: 0,
		expired: 0,
		lostRace: 0,
		skipped: 0,
	};
	const regions = parseRegionConfig(env.REGION_NUMBERS);
	const bots = new BotService(env.DB);

	const { results } = await env.DB.prepare(
		`SELECT s.*, c.window_expires_at
		   FROM bot_sessions s
		   LEFT JOIN conversations c ON c.id = s.conversation_id
		  WHERE s.ended_at IS NULL AND s.step_id IS NOT NULL
		  ORDER BY s.updated_at ASC
		  LIMIT ?1`,
	)
		.bind(SWEEP_BATCH)
		.all<SessionRow & { window_expires_at: string | null }>();

	// Most sessions in one pass share a handful of flow versions.
	const flows = new Map<string, FlowLoad | null>();

	for (const row of results ?? []) {
		result.checked++;
		const region = findRegionById(regions, row.region_id);
		if (!region) {
			// A session for a region no longer configured. Left alone rather
			// than ended: removing a region from configuration should not
			// silently rewrite its history.
			result.skipped++;
			continue;
		}
		const session = toSession(row);
		const key = `${row.region_id}:${row.flow_version}`;
		if (!flows.has(key)) {
			flows.set(key, await bots.flowVersion(row.region_id, row.flow_version));
		}
		const loaded = flows.get(key);

		const action = planFallback({
			session,
			flow: loaded?.ok ? loaded.flow : null,
			region,
			windowExpiresAt: row.window_expires_at,
			now,
		});
		if (action.kind === "none") continue;

		const written = await bots.endSessionIfUnchanged({
			conversationId: row.conversation_id,
			expectedUpdatedAt: row.updated_at,
			ended: action.ended,
		});
		if (!written) {
			result.lostRace++;
			continue;
		}
		await bots.recordTurn({
			conversationId: row.conversation_id,
			regionId: row.region_id,
			flowId: row.flow_id,
			flowVersion: row.flow_version,
			fromStepId: row.step_id,
			toStepId: null,
			endedReason: action.ended.endedReason,
			trace: action.trace,
			now,
		});
		if (action.kind === "handover") result.handedOver++;
		else result.expired++;
	}
	return result;
}
