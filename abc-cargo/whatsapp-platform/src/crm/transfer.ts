/**
 * Handing a conversation to another team, including one in another region.
 *
 * The screen designs offer "Forward to KSA team" and "Transfer to another
 * region". Building it turned up a constraint that the designs do not show,
 * and it is the whole reason this module exists rather than a column change.
 *
 * **A conversation cannot change its WhatsApp number.** The customer messaged
 * `+971800916`. Every reply in that thread leaves from the phone number ID
 * that received it, because that is the thread the customer has on their
 * phone, and because the 24-hour service window is a property of that number
 * and that customer — not of the team holding the work. Replying from the KSA
 * number would start a second, unrelated thread on the customer's handset,
 * from a number they have never contacted, and the window on it would be
 * closed. So a transfer moves *ownership*, never the channel: the KSA team
 * answers the customer, and the message still goes out over the UAE number.
 * `transferConversation` returns the phone number ID unchanged, and
 * `assertChannelUnchanged` exists so that a future caller cannot quietly get
 * this wrong.
 *
 * **The service clock does not restart.** A conversation transferred twenty
 * minutes into a thirty-minute first-response target is ten minutes from
 * late, in the receiving team's hands. Recomputing the due date from the
 * transfer instant would reset it, which makes a transfer the cheapest way to
 * clear a late queue and hides the customer's real wait from the people
 * looking at the dashboard. The customer has been waiting since they wrote,
 * so the due date is preserved and the transfer is recorded beside it.
 *
 * What the receiving team gets instead of a reset clock is an honest warning.
 * Handing UAE work to the UK at 17:00 Dubai time, when London is open, is
 * routine; handing it over at 23:00 Dubai time, when London is shut, sets a
 * target nobody can meet. That is a real operational problem, and the answer
 * is to surface it at the moment of transfer rather than to paper over it
 * with a new due date.
 */

import type { RegionConfig } from "../regions.ts";
import { findRegionById } from "../regions.ts";
import { isWithinBusinessHours } from "../business-hours.ts";
import type { Caller } from "../auth/policy.ts";
import { isService } from "../auth/policy.ts";
import { isBreached, remainingMs } from "./sla.ts";

/** The conversation as a transfer needs to see it. */
export interface TransferableConversation {
	id: string;
	regionId: string;
	/** The number that received the customer's message. Never changes. */
	phoneNumberId: string;
	assignedAgentId?: string | null;
	assignedTeamId?: string | null;
	/** ISO instant the 24-hour service window closes, if it is open. */
	windowExpiresAt?: string | null;
	/** First-response due date, if one has been set and not yet met. */
	firstResponseDueAt?: string | null;
	firstRespondedAt?: string | null;
}

export interface TransferRequest {
	/** The team taking the work. */
	toTeamId: string;
	/** The region that team belongs to. */
	toRegionId: string;
	/** Optional named recipient inside that team. */
	toAgentId?: string | null;
	/** Why, in the transferring person's words. Required — see below. */
	reason: string;
}

export type TransferRefusal =
	| "suspended"
	| "insufficient_role"
	| "wrong_region"
	| "unknown_region"
	| "same_team"
	| "reason_required"
	| "service_caller";

export interface TransferWarning {
	code:
		| "receiving_region_closed"
		| "first_response_already_late"
		| "first_response_due_outside_receiving_hours"
		| "service_window_closed"
		| "service_window_closing_soon";
	message: string;
}

export interface TransferResult {
	ok: true;
	/** The fields to write. */
	patch: {
		regionId: string;
		assignedTeamId: string;
		assignedAgentId: string | null;
		/** Unchanged, and returned so the caller cannot forget. */
		phoneNumberId: string;
		/** Unchanged, deliberately. */
		firstResponseDueAt: string | null;
	};
	/** The audit row. A transfer with no record of who and why is a mystery. */
	record: TransferRecord;
	warnings: TransferWarning[];
}

export interface TransferRecord {
	conversationId: string;
	fromRegionId: string;
	toRegionId: string;
	fromTeamId: string | null;
	toTeamId: string;
	fromAgentId: string | null;
	toAgentId: string | null;
	actor: string;
	reason: string;
	at: string;
	crossRegion: boolean;
}

export type TransferOutcome =
	TransferResult | { ok: false; refusal: TransferRefusal; message: string };

/** The shortest remaining service window worth handing over without comment. */
const WINDOW_SOON_MINUTES = 60;

/**
 * Whether the caller may transfer this conversation at all.
 *
 * Within a region an agent may hand their own work to a colleague — that is
 * ordinary desk-to-desk handover. Across regions it is a supervisor's
 * decision, because pushing work to another country's queue commits a team
 * the sender does not manage and cannot see.
 *
 * Note that transferring *out* deliberately does not require access to the
 * destination region. A UAE team lead moving a case to the UK does not thereby
 * gain any sight of UK records; they are giving work away, not taking it.
 */
export function canTransfer(
	caller: Caller,
	conversation: TransferableConversation,
	toRegionId: string,
): { allowed: boolean; refusal?: TransferRefusal } {
	if (isService(caller)) {
		// A milestone post or a nightly sweep has no judgement about who
		// should pick a case up, and no name to put in the audit row.
		return { allowed: false, refusal: "service_caller" };
	}
	if (caller.status !== "active") {
		return { allowed: false, refusal: "suspended" };
	}
	if (caller.role === "master_admin") return { allowed: true };

	if (!caller.regionIds.includes(conversation.regionId)) {
		return { allowed: false, refusal: "wrong_region" };
	}

	const crossRegion = toRegionId !== conversation.regionId;
	if (crossRegion && caller.role !== "team_lead") {
		return { allowed: false, refusal: "insufficient_role" };
	}

	if (caller.role === "agent") {
		// Same rule as assignment: an agent moves their own work, not
		// somebody else's.
		const owner = conversation.assignedAgentId ?? null;
		if (owner !== null && owner !== caller.id) {
			return { allowed: false, refusal: "insufficient_role" };
		}
	}

	return { allowed: true };
}

/**
 * Performs the transfer, as a pure computation over the records.
 *
 * Returns the patch to write, the audit row to insert and any warnings for
 * the person doing it. Nothing here touches a database or the clock beyond
 * the `now` passed in, so the whole of the rule is testable.
 */
export function transferConversation(
	caller: Caller,
	conversation: TransferableConversation,
	request: TransferRequest,
	regions: RegionConfig[],
	now: Date = new Date(),
): TransferOutcome {
	const decision = canTransfer(caller, conversation, request.toRegionId);
	if (!decision.allowed) {
		return {
			ok: false,
			refusal: decision.refusal!,
			message: refusalMessage(decision.refusal!),
		};
	}

	// A transfer is the one action whose reason cannot be inferred later from
	// the record. "Why is a Dubai claim being answered in London?" has no
	// answer in the data unless somebody wrote one.
	if (!request.reason?.trim()) {
		return {
			ok: false,
			refusal: "reason_required",
			message: "Give a reason for the transfer.",
		};
	}

	const toRegion = findRegionById(regions, request.toRegionId);
	if (!toRegion) {
		return {
			ok: false,
			refusal: "unknown_region",
			message: `Unknown region ${request.toRegionId}.`,
		};
	}

	if (
		request.toTeamId === conversation.assignedTeamId &&
		(request.toAgentId ?? null) === (conversation.assignedAgentId ?? null)
	) {
		return {
			ok: false,
			refusal: "same_team",
			message: "That is already where this conversation sits.",
		};
	}

	const crossRegion = request.toRegionId !== conversation.regionId;
	const warnings = transferWarnings(conversation, toRegion, crossRegion, now);

	return {
		ok: true,
		patch: {
			regionId: request.toRegionId,
			assignedTeamId: request.toTeamId,
			// The named agent if one was given, otherwise back into the
			// receiving team's queue rather than staying with the old owner.
			assignedAgentId: request.toAgentId ?? null,
			phoneNumberId: conversation.phoneNumberId,
			firstResponseDueAt: conversation.firstResponseDueAt ?? null,
		},
		record: {
			conversationId: conversation.id,
			fromRegionId: conversation.regionId,
			toRegionId: request.toRegionId,
			fromTeamId: conversation.assignedTeamId ?? null,
			toTeamId: request.toTeamId,
			fromAgentId: conversation.assignedAgentId ?? null,
			toAgentId: request.toAgentId ?? null,
			actor: caller.kind === "user" ? caller.id : "service",
			reason: request.reason.trim(),
			at: now.toISOString(),
			crossRegion,
		},
		warnings,
	};
}

function transferWarnings(
	conversation: TransferableConversation,
	toRegion: RegionConfig,
	crossRegion: boolean,
	now: Date,
): TransferWarning[] {
	const warnings: TransferWarning[] = [];

	if (crossRegion && !isWithinBusinessHours(toRegion, now)) {
		warnings.push({
			code: "receiving_region_closed",
			message: `${toRegion.label} is closed right now. Nobody will pick this up until it opens.`,
		});
	}

	const due = conversation.firstResponseDueAt;
	const answered = !!conversation.firstRespondedAt;
	if (due && !answered) {
		if (isBreached(due, now)) {
			warnings.push({
				code: "first_response_already_late",
				message:
					"The first-response target has already passed. Transferring does not reset it.",
			});
		} else if (
			crossRegion &&
			!isWithinBusinessHours(toRegion, new Date(Date.parse(due)))
		) {
			// The clock is preserved on purpose, so the honest thing is to say
			// when the target lands at an hour the receiving team is shut.
			warnings.push({
				code: "first_response_due_outside_receiving_hours",
				message: `The first-response target falls outside ${toRegion.label} business hours. It will be missed unless someone answers before the handover.`,
			});
		}
	}

	const expires = conversation.windowExpiresAt;
	if (!expires || Date.parse(expires) <= now.getTime()) {
		warnings.push({
			code: "service_window_closed",
			message:
				"The 24-hour service window is closed. The receiving team can only reply with an approved template.",
		});
	} else {
		const minutesLeft = Math.floor(remainingMs(expires, now) / 60_000);
		if (minutesLeft <= WINDOW_SOON_MINUTES) {
			warnings.push({
				code: "service_window_closing_soon",
				message: `The 24-hour service window closes in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`,
			});
		}
	}

	return warnings;
}

function refusalMessage(refusal: TransferRefusal): string {
	switch (refusal) {
		case "suspended":
			return "This account is suspended.";
		case "insufficient_role":
			return "Transferring to another region is a team lead's decision.";
		case "wrong_region":
			return "This conversation belongs to another region.";
		case "unknown_region":
			return "Unknown region.";
		case "same_team":
			return "That is already where this conversation sits.";
		case "reason_required":
			return "Give a reason for the transfer.";
		case "service_caller":
			return "A service caller cannot transfer a conversation.";
	}
}

/**
 * Guards the one invariant a later change could plausibly break.
 *
 * Called on the write path. If some future reassignment helpfully "corrects"
 * the phone number to match the new region, the customer's thread silently
 * splits in two and the window on the new one is closed. Better to fail the
 * write.
 */
export function assertChannelUnchanged(
	before: TransferableConversation,
	afterPhoneNumberId: string,
): void {
	if (before.phoneNumberId !== afterPhoneNumberId) {
		throw new Error(
			`a transfer must not change the WhatsApp number: conversation ${before.id} received on ${before.phoneNumberId}, write attempted with ${afterPhoneNumberId}`,
		);
	}
}
