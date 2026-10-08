/**
 * Who may see what, in one place.
 *
 * Engage is one application serving three regions, so the question "may this
 * person read this record" has to be answered the same way everywhere. These
 * are pure functions over a principal and a record: no database, no request,
 * no clock. That is deliberate — an authorisation rule that can only be
 * exercised by standing up a Worker is an authorisation rule nobody tests.
 *
 * Every function here fails closed. An unknown role, a missing region, an
 * empty team list: the answer is no.
 */

export const ROLES = ["agent", "team_lead", "master_admin"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
	return (ROLES as readonly string[]).includes(value);
}

/** The person behind a request, once identity has been established. */
export interface Principal {
	id: string;
	email: string;
	displayName: string;
	role: Role;
	status: "active" | "suspended";
	/** Regions reachable through the teams this person belongs to. */
	regionIds: string[];
	teamIds: string[];
}

/**
 * A machine caller — the shipment system posting a milestone, a scheduled
 * sweep. It has no person behind it and no region of its own, so it is
 * modelled separately rather than as a user with every permission.
 */
export interface ServicePrincipal {
	kind: "service";
	name: string;
}

export type Caller = ({ kind: "user" } & Principal) | ServicePrincipal;

export function isService(caller: Caller): caller is ServicePrincipal {
	return caller.kind === "service";
}

/** The reasons a request is refused, as recorded in `access_log`. */
export type DenyReason =
	| "no_identity"
	| "unknown_user"
	| "suspended"
	| "wrong_region"
	| "not_assigned"
	| "insufficient_role";

export type Decision =
	{ allowed: true; reason: "ok" } | { allowed: false; reason: DenyReason };

const ALLOW: Decision = { allowed: true, reason: "ok" };
const deny = (reason: DenyReason): Decision => ({ allowed: false, reason });

/* ------------------------------------------------------------------ regions */

/**
 * Whether the caller may touch anything belonging to a region at all.
 *
 * A master admin covers all three. Everyone else covers the regions their
 * teams place them in — which is why team membership is the only thing that
 * grants regional reach, and why removing someone from a team removes it.
 */
export function canAccessRegion(caller: Caller, regionId: string): boolean {
	if (isService(caller)) return true;
	if (caller.status !== "active") return false;
	if (caller.role === "master_admin") return true;
	return caller.regionIds.includes(regionId);
}

/**
 * The regions a listing should be limited to, or null for "no limit".
 *
 * Null is returned only for a master admin or a service caller. Everyone else
 * gets an explicit list, and an empty list means they see nothing — which is
 * the correct answer for someone in no team, not an invitation to show them
 * everything.
 */
export function regionScope(caller: Caller): string[] | null {
	if (isService(caller)) return null;
	if (caller.status !== "active") return [];
	if (caller.role === "master_admin") return null;
	return [...caller.regionIds];
}

/* ------------------------------------------------------------ conversations */

export interface ConversationRef {
	id: string;
	regionId: string;
	/** The agent who owns it, if any. */
	assignedAgentId?: string | null;
}

/**
 * Whether the caller may read a conversation.
 *
 * The design's rule is that an agent sees only their own conversations. Taken
 * literally that would hide an unassigned conversation from everyone, and an
 * inbox nobody can see is an inbox nobody answers. So an agent may read a
 * conversation in their own region when it is theirs *or* when it is not yet
 * anyone's: the queue is visible, other people's open cases are not.
 *
 * A team lead reads everything in their regions, which is what makes
 * reassignment and escalation possible.
 */
export function canReadConversation(
	caller: Caller,
	conversation: ConversationRef,
): Decision {
	if (isService(caller)) return ALLOW;
	if (caller.status !== "active") return deny("suspended");
	if (caller.role === "master_admin") return ALLOW;
	if (!caller.regionIds.includes(conversation.regionId)) {
		return deny("wrong_region");
	}
	if (caller.role === "team_lead") return ALLOW;

	const owner = conversation.assignedAgentId;
	if (!owner) return ALLOW; // unclaimed: part of the shared queue
	if (owner === caller.id) return ALLOW;
	return deny("not_assigned");
}

/**
 * Whether the caller may reply to a customer.
 *
 * Stricter than reading on purpose. Reading an unclaimed conversation is how
 * an agent decides whether to take it; replying to one they have not taken
 * produces two agents answering the same customer differently, which the
 * customer sees and the platform cannot untangle afterwards. Claim it first.
 */
export function canReplyToConversation(
	caller: Caller,
	conversation: ConversationRef,
): Decision {
	if (isService(caller)) return ALLOW;
	if (caller.status !== "active") return deny("suspended");
	if (caller.role === "master_admin") return ALLOW;
	if (!caller.regionIds.includes(conversation.regionId)) {
		return deny("wrong_region");
	}
	if (caller.role === "team_lead") return ALLOW;
	return conversation.assignedAgentId === caller.id
		? ALLOW
		: deny("not_assigned");
}

/**
 * Whether the caller may assign a conversation to someone.
 *
 * An agent may take an unclaimed one, and may release their own. Moving a
 * conversation from one agent to another is a supervisor's decision, because
 * it is how work gets taken away from someone.
 */
export function canAssignConversation(
	caller: Caller,
	conversation: ConversationRef,
	targetAgentId: string | null,
): Decision {
	if (isService(caller)) return ALLOW;
	if (caller.status !== "active") return deny("suspended");
	if (caller.role === "master_admin") return ALLOW;
	if (!caller.regionIds.includes(conversation.regionId)) {
		return deny("wrong_region");
	}
	if (caller.role === "team_lead") return ALLOW;

	const owner = conversation.assignedAgentId ?? null;
	const takingUnclaimed = owner === null && targetAgentId === caller.id;
	const releasingOwn = owner === caller.id && targetAgentId === null;
	return takingUnclaimed || releasingOwn ? ALLOW : deny("insufficient_role");
}

/* -------------------------------------------------------- regional records */

/**
 * Whether the caller may read an ordinary regional record — a lead, booking,
 * ticket, quotation or call.
 *
 * These are not assigned to an individual the way a conversation is, so the
 * region is the whole of the test. A commercial pipeline that each agent can
 * only see their own slice of stops being a pipeline.
 */
export function canReadRegionalRecord(
	caller: Caller,
	regionId: string,
): Decision {
	if (isService(caller)) return ALLOW;
	if (caller.status !== "active") return deny("suspended");
	if (caller.role === "master_admin") return ALLOW;
	return caller.regionIds.includes(regionId) ? ALLOW : deny("wrong_region");
}

/* ------------------------------------------------------------- administration */

/** Setup: channels, numbers, teams, roles, keys, backups. Admins only. */
export function canAdminister(caller: Caller): Decision {
	if (isService(caller)) return deny("insufficient_role");
	if (caller.status !== "active") return deny("suspended");
	return caller.role === "master_admin" ? ALLOW : deny("insufficient_role");
}

/**
 * Reports. A lead sees their own regions; an admin sees everything.
 *
 * An agent is refused on purpose: regional performance figures are a
 * management view, and the design puts reports behind supervisors.
 */
export function canViewReports(caller: Caller): Decision {
	if (isService(caller)) return ALLOW;
	if (caller.status !== "active") return deny("suspended");
	if (caller.role === "agent") return deny("insufficient_role");
	return ALLOW;
}

/** Which regions a report may cover for this caller. */
export function reportableRegions(caller: Caller): string[] | null {
	return canViewReports(caller).allowed ? regionScope(caller) : [];
}

/**
 * Narrows a requested region filter to what the caller may actually see.
 *
 * The API takes `?region=`, and a caller is free to ask for one they have no
 * business seeing. Rather than trusting the parameter or refusing outright,
 * the request is intersected with the caller's own scope: ask for everything
 * and you get your own regions, ask for someone else's and you get nothing.
 */
export function resolveRegionFilter(
	caller: Caller,
	requested: string | null | undefined,
): string[] | null {
	const scope = regionScope(caller);
	if (!requested) return scope;
	if (scope === null) return [requested];
	return scope.includes(requested) ? [requested] : [];
}
