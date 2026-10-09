import { test } from "node:test";
import assert from "node:assert/strict";
import {
	checkAdministratorRemains,
	checkNotSelfDemotion,
	checkUserChange,
	isUserStatus,
	looksLikeEmail,
	normaliseEmail,
	validateTeam,
	validateUser,
} from "../src/admin/guards.ts";

const REGIONS = ["uae", "ksa", "uk"];

/* ------------------------------------------------------------------ emails */

test("email is lower-cased and trimmed before it is stored", () => {
	// Access asserts an address; a lookup that misses on capitalisation locks
	// somebody out for no reason at all.
	assert.equal(normaliseEmail("  Mariam@ABCCargo.AE "), "mariam@abccargo.ae");
});

test("email validation refuses only what could not be an address", () => {
	// The authority on whether an address is real is the identity provider,
	// which will not issue an assertion for one that is not. Refusing a
	// legitimate but unusual address on a guess is the worse error.
	assert.equal(looksLikeEmail("a@b.c"), true);
	assert.equal(looksLikeEmail("first.last+tag@sub.domain.co.uk"), true);
	assert.equal(looksLikeEmail("odd!but#valid@example.com"), true);

	assert.equal(looksLikeEmail("no-at-sign"), false);
	assert.equal(looksLikeEmail("two@at@signs.com"), false);
	assert.equal(looksLikeEmail("@startswith.com"), false);
	assert.equal(looksLikeEmail("endswith@"), false);
	assert.equal(looksLikeEmail("has space@example.com"), false);
	assert.equal(looksLikeEmail(""), false);
});

/* -------------------------------------------------------------- user input */

test("a user needs an address, a name and a role the platform knows", () => {
	assert.equal(
		validateUser({
			email: "mariam@abccargo.ae",
			displayName: "Mariam",
			role: "agent",
		}).ok,
		true,
	);

	const checks: [Record<string, string>, string][] = [
		[{ email: "nope", displayName: "M", role: "agent" }, "invalid_email"],
		[
			{ email: "m@abccargo.ae", displayName: "   ", role: "agent" },
			"invalid_name",
		],
		[
			{ email: "m@abccargo.ae", displayName: "M", role: "superuser" },
			"invalid_role",
		],
		[
			{
				email: "m@abccargo.ae",
				displayName: "M",
				role: "agent",
				status: "paused",
			},
			"invalid_status",
		],
	];
	for (const [input, expected] of checks) {
		const result = validateUser(input as never);
		assert.equal(result.ok, false, JSON.stringify(input));
		assert.equal(result.ok === false && result.reason, expected);
	}
});

test("statuses are validated rather than trusted", () => {
	assert.equal(isUserStatus("active"), true);
	assert.equal(isUserStatus("suspended"), true);
	assert.equal(isUserStatus("deleted"), false);
});

/* -------------------------------------------------------- lockout guards */

test("the last active administrator cannot be demoted or suspended", () => {
	// The failure this prevents is quiet and complete: from that moment nobody
	// can create a user, change a role, or undo it. Recovery means writing SQL
	// against production.
	const only = ["usr_admin"];

	const demote = checkAdministratorRemains(only, "usr_admin", {
		role: "team_lead",
	});
	assert.equal(demote.ok, false);
	assert.equal(demote.ok === false && demote.reason, "last_administrator");

	const suspend = checkAdministratorRemains(only, "usr_admin", {
		status: "suspended",
	});
	assert.equal(suspend.ok, false);
	assert.equal(suspend.ok === false && suspend.reason, "last_administrator");
});

test("an administrator may be demoted once another one exists", () => {
	const two = ["usr_admin", "usr_second"];
	assert.equal(
		checkAdministratorRemains(two, "usr_admin", { role: "agent" }).ok,
		true,
	);
});

test("changes that leave the administrator an administrator are allowed", () => {
	const only = ["usr_admin"];
	// Renaming, or re-saving with no role change, must not trip the guard.
	assert.equal(checkAdministratorRemains(only, "usr_admin", {}).ok, true);
	assert.equal(
		checkAdministratorRemains(only, "usr_admin", {
			role: "master_admin",
			status: "active",
		}).ok,
		true,
	);
	// And changing somebody else entirely is none of this guard's business.
	assert.equal(
		checkAdministratorRemains(only, "usr_agent", { status: "suspended" }).ok,
		true,
	);
});

test("you cannot remove your own administrator role, even with others left", () => {
	// Far more likely than doing it to a colleague, and a clearer message than
	// one about counts.
	const two = ["usr_admin", "usr_second"];
	const result = checkNotSelfDemotion("usr_admin", "usr_admin", {
		role: "agent",
	});
	assert.equal(result.ok, false);
	assert.equal(result.ok === false && result.reason, "self_demotion");
	assert.match(
		result.ok === false ? result.message : "",
		/ask another administrator/,
	);

	// Suspending yourself is the same mistake wearing a different hat.
	assert.equal(
		checkNotSelfDemotion("usr_admin", "usr_admin", { status: "suspended" }).ok,
		false,
	);

	// Demoting a different administrator is fine while others remain.
	assert.equal(
		checkNotSelfDemotion("usr_admin", "usr_second", { role: "agent" }).ok,
		true,
	);
	assert.equal(
		checkAdministratorRemains(two, "usr_second", { role: "agent" }).ok,
		true,
	);
});

test("the combined check reports self-demotion before the count", () => {
	// One entry point, so a new rule cannot be added in one place and
	// forgotten in another.
	const result = checkUserChange({
		actingUserId: "usr_admin",
		targetUserId: "usr_admin",
		activeAdminIds: ["usr_admin"],
		next: { role: "agent" },
	});
	assert.equal(result.ok, false);
	// Both rules would refuse; the clearer message wins.
	assert.equal(result.ok === false && result.reason, "self_demotion");
});

test("the combined check still catches demoting the last administrator", () => {
	// Another administrator doing it, so self-demotion does not apply, but it
	// would still leave nobody.
	const result = checkUserChange({
		actingUserId: "usr_second",
		targetUserId: "usr_admin",
		activeAdminIds: ["usr_admin"],
		next: { status: "suspended" },
	});
	assert.equal(result.ok, false);
	assert.equal(result.ok === false && result.reason, "last_administrator");
});

/* ------------------------------------------------------------------ teams */

test("a team needs a name and a region the platform actually runs", () => {
	assert.equal(
		validateTeam({ name: "UAE Sales", regionId: "uae" }, REGIONS).ok,
		true,
	);

	const noName = validateTeam({ name: "  ", regionId: "uae" }, REGIONS);
	assert.equal(noName.ok === false && noName.reason, "invalid_name");

	const badRegion = validateTeam(
		{ name: "Mars Sales", regionId: "mars" },
		REGIONS,
	);
	assert.equal(badRegion.ok === false && badRegion.reason, "unknown_region");
	assert.match(badRegion.ok === false ? badRegion.message : "", /uae, ksa, uk/);
});
