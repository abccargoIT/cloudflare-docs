/**
 * What a broadcast is, and the states it can be in.
 *
 * The lifecycle is the design. A broadcast cannot go from an idea to thousands
 * of customers in one step, and the intermediate steps are not ceremony:
 *
 *   draft  →  resolved  →  review  →  approved  →  sending  →  sent
 *                                                     ↕
 *                                                   paused
 *
 * **Resolving** writes down exactly who will be messaged. **Approval** then
 * applies to that written-down list. Re-resolving voids the approval, because
 * the approval was of particular people — the most dangerous bug this module
 * could have is an approved broadcast quietly acquiring recipients nobody
 * looked at.
 */

export const BROADCAST_KINDS = ["marketing", "service"] as const;
export type BroadcastKind = (typeof BROADCAST_KINDS)[number];

export function isBroadcastKind(value: string): value is BroadcastKind {
	return (BROADCAST_KINDS as readonly string[]).includes(value);
}

export const BROADCAST_STATUSES = [
	"draft",
	"review",
	"approved",
	"sending",
	"paused",
	"sent",
	"cancelled",
] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

/** States a single recipient passes through. */
export const RECIPIENT_STATES = [
	"pending",
	"skipped",
	"sending",
	"sent",
	"delivered",
	"read",
	"replied",
	"failed",
] as const;
export type RecipientState = (typeof RECIPIENT_STATES)[number];

/**
 * Why somebody in the audience was not messaged.
 *
 * Recorded rather than inferred. "4,812 of 5,000 sent" invites the question,
 * and an opt-out that silently drops somebody from a count is how a platform
 * ends up messaging them again next time.
 */
export const SKIP_REASONS = ["opted_out", "not_opted_in", "no_wa_id"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/**
 * Delivery states, in the order they can only move forwards through.
 *
 * WhatsApp does not promise the order its status webhooks arrive in, so a
 * `read` followed by a late `delivered` must not move a recipient backwards.
 */
export const DELIVERY_ORDER: RecipientState[] = [
	"sending",
	"sent",
	"delivered",
	"read",
	"replied",
];

/** Whether a delivery state may replace another. Forward only. */
export function advances(from: RecipientState, to: RecipientState): boolean {
	const a = DELIVERY_ORDER.indexOf(from);
	const b = DELIVERY_ORDER.indexOf(to);
	// A state outside the delivery sequence — skipped, failed, pending — is
	// not something a late status webhook should overwrite.
	if (a < 0 || b < 0) return false;
	return b > a;
}

export interface BroadcastRow {
	id: string;
	region_id: string;
	name: string;
	kind: string;
	template_name: string;
	language_code: string;
	components: string | null;
	audience: string;
	status: string;
	rate_per_minute: number;
	created_by: string;
	created_at: string;
	updated_at: string;
	resolved_at: string | null;
	resolved_count: number | null;
	approved_by: string | null;
	approved_at: string | null;
	started_at: string | null;
	finished_at: string | null;
	cancelled_by: string | null;
	cancelled_at: string | null;
	cancel_reason: string | null;
}

export interface RecipientRow {
	broadcast_id: string;
	wa_id: string;
	customer_id: string | null;
	region_id: string;
	state: string;
	skip_reason: string | null;
	conversation_id: string | null;
	wa_message_id: string | null;
	attempts: number;
	error_code: number | null;
	error_message: string | null;
	queued_at: string | null;
	sent_at: string | null;
	delivered_at: string | null;
	read_at: string | null;
	replied_at: string | null;
}

/** What a broadcast's progress looks like, counted from the recipient rows. */
export interface BroadcastProgress {
	audience: number;
	pending: number;
	skipped: number;
	sent: number;
	delivered: number;
	read: number;
	replied: number;
	failed: number;
	/** Of those skipped, why. */
	skips: Record<string, number>;
}

/**
 * How long after a send an inbound message counts as a reply to it.
 *
 * Three days. A customer answering a week later is answering something else,
 * and a broadcast that claims the credit for every conversation that follows
 * it makes its own figures useless.
 */
export const REPLY_ATTRIBUTION_HOURS = 72;
