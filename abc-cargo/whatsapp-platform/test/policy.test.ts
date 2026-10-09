import { test } from "node:test";
import assert from "node:assert/strict";
import {
	canAccessRegion,
	canAdminister,
	canAssignConversation,
	canReadConversation,
	canReadRegionalRecord,
	canReplyToConversation,
	canViewReports,
	isRole,
	regionScope,
	reportableRegions,
	resolveRegionFilter,
	type Caller,
} from "../src/auth/policy.ts";

function agent(overrides: Partial<Caller> = {}): Caller {
	return {
		kind: "user",
		id: "usr_mariam",
		email: "mariam@abccargo.invalid",
		displayName: "Mariam",
		role: "agent",
		status: "active",
		regionIds: ["uae"],
		teamIds: ["team_uae_sales"],
		...overrides,
	} as Caller;
}

const lead = () =>
	agent({ id: "usr_lead", role: "team_lead", regionIds: ["uae", "ksa"] });
const admin = () => agent({ id: "usr_admin", role: "master_admin" });
const service: Caller = { kind: "service", name: "shipment-system" };

const uaeUnclaimed = { id: "cv1", regionId: "uae", assignedAgentId: null };
const uaeMine = { id: "cv2", regionId: "uae", assignedAgentId: "usr_mariam" };
const uaeTheirs = { id: "cv3", regionId: "uae", assignedAgentId: "usr_omar" };
const ksaTheirs = { id: "cv4", regionId: "ksa", assignedAgentId: "usr_aziz" };

/* ------------------------------------------------------------------ regions */

test("an agent reaches only the regions their teams place them in", () => {
	assert.equal(canAccessRegion(agent(), "uae"), true);
	assert.equal(canAccessRegion(agent(), "ksa"), false);
	assert.equal(canAccessRegion(lead(), "ksa"), true);
	assert.equal(canAccessRegion(admin(), "uk"), true);
});

test("a suspended person reaches nothing, whatever their role", () => {
	const suspended = agent({ role: "master_admin", status: "suspended" });
	assert.equal(canAccessRegion(suspended, "uae"), false);
	assert.deepEqual(regionScope(suspended), []);
	assert.equal(canAdminister(suspended).reason, "suspended");
	assert.equal(canReadConversation(suspended, uaeMine).reason, "suspended");
});

test("belonging to no team means seeing nothing, not seeing everything", () => {
	// The failure mode worth guarding: an empty scope read as "no filter".
	const orphan = agent({ regionIds: [], teamIds: [] });
	assert.deepEqual(regionScope(orphan), []);
	assert.equal(canAccessRegion(orphan, "uae"), false);
	assert.equal(
		canReadConversation(orphan, uaeUnclaimed).reason,
		"wrong_region",
	);
});

test("only an admin or a service caller has an unlimited scope", () => {
	assert.equal(regionScope(admin()), null);
	assert.equal(regionScope(service), null);
	assert.deepEqual(regionScope(agent()), ["uae"]);
	assert.deepEqual(regionScope(lead()), ["uae", "ksa"]);
});

/* ------------------------------------------------------------ conversations */

test("an agent reads their own conversations and the unclaimed queue", () => {
	// Unclaimed has to be visible or nobody picks anything up.
	assert.equal(canReadConversation(agent(), uaeUnclaimed).allowed, true);
	assert.equal(canReadConversation(agent(), uaeMine).allowed, true);
	assert.equal(canReadConversation(agent(), uaeTheirs).reason, "not_assigned");
	assert.equal(canReadConversation(agent(), ksaTheirs).reason, "wrong_region");
});

test("a team lead reads everything in their own regions and no further", () => {
	assert.equal(canReadConversation(lead(), uaeTheirs).allowed, true);
	assert.equal(canReadConversation(lead(), ksaTheirs).allowed, true);
	assert.equal(
		canReadConversation(lead(), {
			id: "cv5",
			regionId: "uk",
			assignedAgentId: null,
		}).reason,
		"wrong_region",
	);
});

test("replying is stricter than reading: claim it first", () => {
	// Reading an unclaimed conversation is how an agent decides to take it.
	// Replying to one they have not taken means two agents answering one
	// customer differently.
	assert.equal(canReadConversation(agent(), uaeUnclaimed).allowed, true);
	assert.equal(
		canReplyToConversation(agent(), uaeUnclaimed).reason,
		"not_assigned",
	);
	assert.equal(canReplyToConversation(agent(), uaeMine).allowed, true);
	assert.equal(canReplyToConversation(lead(), uaeTheirs).allowed, true);
});

test("an agent may take an unclaimed conversation and release their own", () => {
	assert.equal(
		canAssignConversation(agent(), uaeUnclaimed, "usr_mariam").allowed,
		true,
	);
	assert.equal(canAssignConversation(agent(), uaeMine, null).allowed, true);
});

test("taking work away from another agent is a supervisor's decision", () => {
	assert.equal(
		canAssignConversation(agent(), uaeTheirs, "usr_mariam").reason,
		"insufficient_role",
	);
	// Nor by handing an unclaimed one to somebody else.
	assert.equal(
		canAssignConversation(agent(), uaeUnclaimed, "usr_omar").reason,
		"insufficient_role",
	);
	assert.equal(
		canAssignConversation(lead(), uaeTheirs, "usr_mariam").allowed,
		true,
	);
});

/* -------------------------------------------------------- regional records */

test("commercial records are regional, not personal", () => {
	// A pipeline each agent sees only their own slice of is not a pipeline.
	assert.equal(canReadRegionalRecord(agent(), "uae").allowed, true);
	assert.equal(canReadRegionalRecord(agent(), "ksa").reason, "wrong_region");
	assert.equal(canReadRegionalRecord(admin(), "uk").allowed, true);
});

/* ---------------------------------------------------------- administration */

test("setup is for master admins, and a service key is not an admin", () => {
	assert.equal(canAdminister(admin()).allowed, true);
	assert.equal(canAdminister(lead()).reason, "insufficient_role");
	assert.equal(canAdminister(agent()).reason, "insufficient_role");
	// A machine credential must not be able to add users or rotate keys.
	assert.equal(canAdminister(service).reason, "insufficient_role");
});

test("reports are a supervisor's view", () => {
	assert.equal(canViewReports(agent()).reason, "insufficient_role");
	assert.equal(canViewReports(lead()).allowed, true);
	assert.deepEqual(reportableRegions(agent()), []);
	assert.deepEqual(reportableRegions(lead()), ["uae", "ksa"]);
	assert.equal(reportableRegions(admin()), null);
});

/* --------------------------------------------------------- requested filter */

test("a requested region is intersected with the caller's own scope", () => {
	// Asking for a region you have no business in returns nothing, rather
	// than being trusted or rejected outright.
	assert.deepEqual(resolveRegionFilter(agent(), "uae"), ["uae"]);
	assert.deepEqual(resolveRegionFilter(agent(), "ksa"), []);
	assert.deepEqual(resolveRegionFilter(agent(), null), ["uae"]);
	assert.deepEqual(resolveRegionFilter(lead(), "ksa"), ["ksa"]);
	assert.deepEqual(resolveRegionFilter(admin(), "uk"), ["uk"]);
	assert.equal(resolveRegionFilter(admin(), null), null);
	assert.equal(resolveRegionFilter(service, null), null);
});

test("role names are validated rather than trusted", () => {
	assert.equal(isRole("agent"), true);
	assert.equal(isRole("master_admin"), true);
	assert.equal(isRole("superuser"), false);
	assert.equal(isRole(""), false);
});
