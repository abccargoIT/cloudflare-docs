/**
 * Sending a broadcast, a few messages at a time.
 *
 * Driven by the scheduled handler rather than by the request that pressed
 * Send. A campaign of several thousand cannot be sent inside one request, and
 * a request that tried would be killed part way through with no record of how
 * far it had got.
 *
 * Three things are done here that are not obvious and are not optional.
 *
 * **Pacing.** Meta throttles a number that sends too fast and lowers its
 * quality rating, and that rating is shared with every ordinary customer
 * conversation on the same number. A campaign that gets the UAE number
 * rate-limited has damaged the thing it was meant to support.
 *
 * **Opt-out is re-checked immediately before sending.** The audience was
 * frozen when it was resolved, which is what makes approval meaningful, but
 * somebody who asked not to be contacted yesterday must not be messaged today
 * because of a list drawn up last week. This is the check that makes the
 * freezing safe.
 *
 * **One failure does not stop the campaign.** A single number that Meta
 * rejects is recorded against that recipient and the batch carries on. The
 * alternative — aborting — leaves a campaign stuck on one bad row.
 */

import type { Conversation } from "../conversation.ts";
import type { Env } from "../env.ts";
import { conversationIdFor } from "../conversation.ts";
import { findRegionById, parseRegionConfig } from "../regions.ts";
import { BroadcastService } from "./service.ts";
import { parseTemplateComponents } from "./template.ts";
import type { BroadcastRow } from "./types.ts";

/**
 * How often the pacer runs. The rate on a broadcast is per minute, so this is
 * the denominator for how many each pass may send.
 */
export const PACER_INTERVAL_SECONDS = 60;

/**
 * The most any single pass will send, whatever the configured rate.
 *
 * A scheduled invocation has a limited budget, and a pass that tries to do too
 * much is killed part way with some recipients left in `sending` — recoverable,
 * but it needs a human to notice.
 */
export const MAX_PER_PASS = 60;

export interface SendPassResult {
	broadcastId: string;
	sent: number;
	skipped: number;
	failed: number;
	finished: boolean;
}

/** Whether this deployment may send broadcasts at all. */
export function sendingEnabled(env: Env): boolean {
	return env.BROADCASTS_ENABLED === "true";
}

/**
 * One pass over every broadcast that is mid-send.
 *
 * Returns what it did rather than logging and forgetting, so the scheduled
 * handler can record it and a test can assert on it.
 */
export async function runSendPass(
	env: Env,
	now: Date = new Date(),
): Promise<SendPassResult[]> {
	// The switch is checked here as well as at the route. A broadcast left in
	// `sending` when the switch was turned off must not quietly resume.
	if (!sendingEnabled(env)) return [];

	const service = new BroadcastService(env.DB);
	const running = await service.sendingBroadcasts();
	const results: SendPassResult[] = [];
	for (const broadcast of running) {
		results.push(await sendOne({ env, service, broadcast, now }));
	}
	return results;
}

async function sendOne(input: {
	env: Env;
	service: BroadcastService;
	broadcast: BroadcastRow;
	now: Date;
}): Promise<SendPassResult> {
	const { env, service, broadcast, now } = input;
	const result: SendPassResult = {
		broadcastId: broadcast.id,
		sent: 0,
		skipped: 0,
		failed: 0,
		finished: false,
	};

	const regions = parseRegionConfig(env.REGION_NUMBERS);
	const region = findRegionById(regions, broadcast.region_id);
	if (!region) {
		// The number this campaign belongs to is no longer configured. Stopping
		// is the only safe answer: the alternative is sending from whichever
		// number happens to be first.
		console.error("broadcast paused: region no longer configured", {
			broadcastId: broadcast.id,
			regionId: broadcast.region_id,
		});
		await service.setStatus({
			id: broadcast.id,
			status: "paused",
			actor: "system",
			now,
		});
		return result;
	}

	const batchSize = Math.min(broadcast.rate_per_minute, MAX_PER_PASS);
	const claimed = await service.claimBatch({
		broadcastId: broadcast.id,
		size: batchSize,
		now,
	});

	if (claimed.length === 0) {
		// Nothing claimed and nothing in flight means the campaign is done.
		const pending = await service.pendingCount(broadcast.id);
		if (pending === 0) {
			await service.setStatus({
				id: broadcast.id,
				status: "sent",
				actor: "system",
				now,
			});
			result.finished = true;
		}
		return result;
	}

	// Asked once for the whole batch rather than once per recipient.
	const optedOut = await service.optedOutAmong(claimed.map((r) => r.wa_id));

	const components = readComponents(broadcast.components);

	for (const recipient of claimed) {
		if (optedOut.has(recipient.wa_id)) {
			// Opted out between the list being drawn up and this moment. This is
			// the check that makes freezing the audience safe.
			await service.markSkipped({
				broadcastId: broadcast.id,
				waId: recipient.wa_id,
				reason: "opted_out",
			});
			result.skipped++;
			continue;
		}

		const conversationId = conversationIdFor(
			region.phoneNumberId,
			recipient.wa_id,
		);
		const stub: DurableObjectStub<Conversation> = env.CONVERSATION.get(
			env.CONVERSATION.idFromName(conversationId),
		);

		try {
			const sent = await stub.sendTemplate({
				init: {
					phoneNumberId: region.phoneNumberId,
					waId: recipient.wa_id,
				},
				requestedBy: `broadcast:${broadcast.id}`,
				template: {
					name: broadcast.template_name,
					languageCode: broadcast.language_code,
					...(components ? { components } : {}),
				},
			});
			await service.markSent({
				broadcastId: broadcast.id,
				waId: recipient.wa_id,
				conversationId,
				waMessageId: sent.messageId,
				now,
			});
			result.sent++;
		} catch (error) {
			// Recorded against this recipient, and the batch carries on. One
			// number Meta rejects must not strand the campaign.
			const message = error instanceof Error ? error.message : String(error);
			await service.markFailed({
				broadcastId: broadcast.id,
				waId: recipient.wa_id,
				message,
			});
			result.failed++;
		}
	}

	const pending = await service.pendingCount(broadcast.id);
	if (pending === 0) {
		await service.setStatus({
			id: broadcast.id,
			status: "sent",
			actor: "system",
			now,
		});
		result.finished = true;
	}
	return result;
}

/**
 * Template variables, validated once for the whole batch.
 *
 * The same check ran when the campaign was composed, so a stored document that
 * fails here is a surprise worth logging. Sending without variables is the
 * better failure: Meta rejects it per recipient with a clear reason, which is
 * recorded against each one, rather than the campaign stopping with nothing to
 * explain it.
 */
function readComponents(json: string | null) {
	if (!json) return undefined;
	const parsed = parseTemplateComponents(json);
	if (parsed.ok) return parsed.components;
	console.error("broadcast has an unreadable components document", {
		problems: parsed.problems,
	});
	return undefined;
}
