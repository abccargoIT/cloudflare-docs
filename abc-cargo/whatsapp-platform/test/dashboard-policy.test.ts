import { test } from "node:test";
import assert from "node:assert/strict";
import {
	canSeeAgentWorkload,
	canSeeOwnQueue,
	canViewDashboard,
	canViewReports,
	seesEveryConversationInRegion,
	type Caller,
} from "../src/auth/policy.ts";
import {
	countOnlineIn,
	coversRegion,
	PRESENCE_TTL_MINUTES,
	staleBefore,
	type OnlinePerson,
} from "../src/dashboard/presence.ts";

function person(overrides: Partial<Caller> = {}): Caller {
	return {
		kind: "user",
		id: "usr_mariam",
		email: "mariam@abccargo.ae",
		displayName: "Mariam",
		role: "agent",
		status: "active",
		regionIds: ["uae"],
		teamIds: ["team_uae_sales"],
		...overrides,
	} as Caller;
}

const service: Caller = { kind: "service", name: "wallboard" };

/* ------------------------------------------------------------------ access */

test("an agent gets a dashboard but not reports", () => {
	// The whole reason the dashboard is a separate module. An agent must see
	// what is waiting; regional performance figures are a management view.
	const agent = person();
	assert.equal(canViewDashboard(agent).allowed, true);
	assert.equal(canViewReports(agent).allowed, false);
	assert.equal(canSeeAgentWorkload(agent).allowed, false);
});

test("a supervisor gets the breakdown by colleague", () => {
	const lead = person({ role: "team_lead" });
	assert.equal(canViewDashboard(lead).allowed, true);
	assert.equal(canSeeAgentWorkload(lead).allowed, true);
});

test("a suspended person gets nothing, dashboard included", () => {
	const suspended = person({ status: "suspended" });
	assert.equal(canViewDashboard(suspended).reason, "suspended");
	assert.equal(canSeeOwnQueue(suspended), false);
});

test("a wallboard may poll, and has no personal queue", () => {
	// A service key behind an office screen is a legitimate reader of queue
	// state. It has no desk, so there is nothing personal to show it.
	assert.equal(canViewDashboard(service).allowed, true);
	assert.equal(canSeeOwnQueue(service), false);
	assert.equal(canSeeOwnQueue(person()), true);
});

test("an agent's listing is narrowed the same way a single read is", () => {
	// If this ever disagreed with canReadConversation, the dashboard would
	// become the way round it.
	assert.equal(seesEveryConversationInRegion(person()), false);
	assert.equal(
		seesEveryConversationInRegion(person({ role: "team_lead" })),
		true,
	);
	assert.equal(
		seesEveryConversationInRegion(person({ role: "master_admin" })),
		true,
	);
	assert.equal(seesEveryConversationInRegion(service), true);
	assert.equal(
		seesEveryConversationInRegion(
			person({ role: "team_lead", status: "suspended" }),
		),
		false,
	);
});

/* ---------------------------------------------------------------- presence */

function online(overrides: Partial<OnlinePerson> = {}): OnlinePerson {
	return {
		id: "usr_mariam",
		name: "Mariam",
		regionIds: ["uae"],
		source: "user",
		...overrides,
	};
}

test("somebody in no team covers every region", () => {
	// Which is how a master admin appears, and matches what a null region
	// meant in the older agents table.
	const everywhere = online({ regionIds: null });
	assert.equal(coversRegion(everywhere, "uae"), true);
	assert.equal(coversRegion(everywhere, "uk"), true);
	assert.equal(coversRegion(online(), "uk"), false);
	assert.equal(
		coversRegion(online({ regionIds: ["uae", "ksa"] }), "ksa"),
		true,
	);
});

test("counting online people per region", () => {
	const people = [
		online({ id: "a", regionIds: ["uae"] }),
		online({ id: "b", regionIds: ["ksa"] }),
		online({ id: "c", regionIds: null }),
	];
	assert.equal(countOnlineIn(people, "uae"), 2);
	assert.equal(countOnlineIn(people, "ksa"), 2);
	assert.equal(countOnlineIn(people, "uk"), 1);
	assert.equal(countOnlineIn([], "uae"), 0);
});

test("presence older than the refresh window is not believed", () => {
	// An agent who closed the tab three hours ago must not suppress the
	// automated reply. Failing towards "nobody is here" means the customer gets
	// an acknowledgement they did not strictly need, rather than silence.
	const now = new Date("2026-10-08T12:00:00.000Z");
	const cutoff = staleBefore(now);
	assert.equal(
		cutoff,
		new Date(now.getTime() - PRESENCE_TTL_MINUTES * 60_000).toISOString(),
	);
	assert.ok(cutoff < now.toISOString());
	// A row written just inside the window still counts; one outside does not.
	assert.ok("2026-10-08T11:50:00.000Z" >= cutoff);
	assert.ok(!("2026-10-08T11:30:00.000Z" >= cutoff));
});
