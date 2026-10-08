/**
 * Who may read and post in an internal thread.
 *
 * Team chat is the one part of Engage that crosses regions deliberately, so
 * the rules here are not the regional ones and should not be mistaken for
 * them. What governs a thread is membership: you are in it, or you are not.
 *
 * Pure functions over plain data, for the same reason as the regional policy —
 * an authorisation rule that needs a database to exercise is one nobody tests.
 */

import type { Caller } from "../auth/policy.ts";

export const THREAD_KINDS = ["direct", "team"] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

export interface ThreadRef {
	id: string;
	kind: ThreadKind;
	/** Set for a team thread. */
	teamId?: string | null;
	/** Everyone in the thread, by user id. */
	participantIds: string[];
}

export type ChatDeny =
	| "not_a_participant"
	| "suspended"
	| "service_caller"
	| "not_the_author"
	| "empty_message";

/**
 * Shaped like the regional `Decision`, reason and all, so a caller reads both
 * the same way and neither needs a narrowing dance to log why.
 */
export type ChatDecision =
	{ allowed: true; reason: "ok" } | { allowed: false; reason: ChatDeny };

const ALLOW: ChatDecision = { allowed: true, reason: "ok" };
const deny = (reason: ChatDeny): ChatDecision => ({ allowed: false, reason });

/**
 * A machine caller has no place in a staff conversation.
 *
 * Everything else in the platform lets a service principal through, because
 * the shipment system genuinely needs to write a milestone. Nothing needs to
 * read what colleagues said to each other, and a credential that could would
 * be an odd thing to leave lying in a config file.
 */
function requirePerson(caller: Caller): ChatDecision | null {
	if (caller.kind === "service") return deny("service_caller");
	if (caller.status !== "active") return deny("suspended");
	return null;
}

/** Reading a thread requires being in it. Role does not substitute. */
export function canReadThread(caller: Caller, thread: ThreadRef): ChatDecision {
	const refused = requirePerson(caller);
	if (refused) return refused;
	// Deliberately no master_admin exception. An administrator can grant
	// themselves access to anything by adding themselves, which leaves a
	// record; a silent back door into colleagues' messages would not.
	return thread.participantIds.includes((caller as { id: string }).id)
		? ALLOW
		: deny("not_a_participant");
}

/** Posting requires being in the thread, and something to say. */
export function canPostToThread(
	caller: Caller,
	thread: ThreadRef,
	body: string,
): ChatDecision {
	const readable = canReadThread(caller, thread);
	if (!readable.allowed) return readable;
	return body.trim().length > 0 ? ALLOW : deny("empty_message");
}

/**
 * Editing is limited to the author.
 *
 * A supervisor may need to remove something, which is a deletion and a
 * different act with a different record. Rewriting what a colleague said,
 * under their name, is not something the platform should make easy.
 */
export function canEditMessage(
	caller: Caller,
	thread: ThreadRef,
	authorId: string,
): ChatDecision {
	const readable = canReadThread(caller, thread);
	if (!readable.allowed) return readable;
	return (caller as { id: string }).id === authorId
		? ALLOW
		: deny("not_the_author");
}

/**
 * The key that makes a direct thread unique between two people.
 *
 * Sorted, so starting from either end finds the same thread. Without this,
 * two colleagues messaging each other at the same moment end up with two
 * threads and each sees half the conversation.
 */
export function directKey(a: string, b: string): string {
	if (!a || !b) throw new Error("both participants are required");
	if (a === b) throw new Error("a direct thread needs two different people");
	return [a, b].sort().join("|");
}

/**
 * Whether a caller may start a direct thread with someone.
 *
 * Across regions on purpose: a UAE agent asking a KSA colleague about a
 * shipment is the reason this module exists.
 */
export function canStartDirect(
	caller: Caller,
	otherUserId: string,
): ChatDecision {
	const refused = requirePerson(caller);
	if (refused) return refused;
	if (!otherUserId || otherUserId === (caller as { id: string }).id) {
		return deny("not_a_participant");
	}
	return ALLOW;
}

/**
 * How many messages in a thread the reader has not seen.
 *
 * Counted from their own last-read mark rather than a flag on the message,
 * because the same message is read by different people at different times.
 */
export function unreadCount(
	messages: { createdAt: string; authorId: string }[],
	lastReadAt: string | null | undefined,
	readerId: string,
): number {
	const since = lastReadAt ? Date.parse(lastReadAt) : 0;
	const from = Number.isFinite(since) ? since : 0;
	return messages.filter((message) => {
		// Your own messages are never unread to you.
		if (message.authorId === readerId) return false;
		const at = Date.parse(message.createdAt);
		return Number.isFinite(at) && at > from;
	}).length;
}
