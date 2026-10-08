import { test } from "node:test";
import assert from "node:assert/strict";
import {
	checkTarget,
	effectivePolicyTable,
	resolveTarget,
	validateTeamPolicy,
	type RegionSlaPolicy,
	type TeamSlaPolicy,
} from "../src/crm/sla-policy.ts";

/** The two teams named in the screen designs. */
const uaeSupport: TeamSlaPolicy = {
	teamId: "uae-support",
	regionId: "uae",
	byType: {
		claim: { firstResponseMinutes: 5, resolutionMinutes: 4 * 60 },
	},
	fallback: { firstResponseMinutes: 5, resolutionMinutes: 4 * 60 },
};

const uaeSales: TeamSlaPolicy = {
	teamId: "uae-sales",
	regionId: "uae",
	fallback: { firstResponseMinutes: 15, resolutionMinutes: 24 * 60 },
};

const uaeRegion: RegionSlaPolicy = {
	regionId: "uae",
	byType: { billing: { firstResponseMinutes: 90, resolutionMinutes: 16 * 60 } },
	fallback: { firstResponseMinutes: 60, resolutionMinutes: 12 * 60 },
};

test("the team's own per-type policy wins, and says so", () => {
	const r = resolveTarget("claim", "normal", {
		teamIds: ["uae-support"],
		regionId: "uae",
		teamPolicies: [uaeSupport, uaeSales],
		regionPolicies: [uaeRegion],
	});
	assert.equal(r.source, "team_type");
	assert.equal(r.teamId, "uae-support");
	assert.equal(r.stated.firstResponseMinutes, 5);
	assert.equal(r.stated.resolutionMinutes, 240);
	assert.deepEqual(r.ignored, []);
});

test("the team fallback covers types the team did not set", () => {
	const r = resolveTarget("documentation", "normal", {
		teamIds: ["uae-sales"],
		regionId: "uae",
		teamPolicies: [uaeSupport, uaeSales],
		regionPolicies: [uaeRegion],
	});
	assert.equal(r.source, "team_fallback");
	assert.equal(r.stated.firstResponseMinutes, 15);
});

test("a team with no policy inherits the region, per type then default", () => {
	const billing = resolveTarget("billing", "normal", {
		teamIds: ["uae-nightshift"],
		regionId: "uae",
		teamPolicies: [uaeSupport],
		regionPolicies: [uaeRegion],
	});
	assert.equal(billing.source, "region_type");
	assert.equal(billing.stated.firstResponseMinutes, 90);

	const general = resolveTarget("general", "normal", {
		teamIds: ["uae-nightshift"],
		regionId: "uae",
		teamPolicies: [uaeSupport],
		regionPolicies: [uaeRegion],
	});
	assert.equal(general.source, "region_fallback");
	assert.equal(general.stated.firstResponseMinutes, 60);
});

test("with nothing configured the platform default always resolves", () => {
	const r = resolveTarget("claim", "normal");
	assert.equal(r.source, "platform_default");
	assert.equal(r.teamId, null);
	assert.equal(r.stated.firstResponseMinutes, 30);
});

test("priority shortens the resolved target but not the stated policy", () => {
	const r = resolveTarget("claim", "urgent", {
		teamIds: ["uae-support"],
		regionId: "uae",
		teamPolicies: [uaeSupport],
	});
	// Stated policy is what the supervisor typed; the target is what applies.
	assert.equal(r.stated.resolutionMinutes, 240);
	assert.equal(r.target.resolutionMinutes, 60);
});

test("a policy below the platform floor is raised, and the gap is visible", () => {
	const keen: TeamSlaPolicy = {
		teamId: "keen",
		regionId: "uae",
		fallback: { firstResponseMinutes: 2, resolutionMinutes: 30 },
	};
	const r = resolveTarget("general", "normal", {
		teamIds: ["keen"],
		regionId: "uae",
		teamPolicies: [keen],
	});
	assert.equal(r.stated.firstResponseMinutes, 2, "what the team asked for");
	assert.equal(r.target.firstResponseMinutes, 5, "what the platform allows");
});

/* --------------------------------------------- malformed policies fall through */

test("a malformed team policy is ignored, reported, and not fatal", () => {
	const broken = {
		teamId: "broken",
		regionId: "uae",
		fallback: { firstResponseMinutes: -5, resolutionMinutes: 60 },
	} as TeamSlaPolicy;

	const r = resolveTarget("general", "normal", {
		teamIds: ["broken"],
		regionId: "uae",
		teamPolicies: [broken],
		regionPolicies: [uaeRegion],
	});

	assert.equal(r.source, "region_fallback", "fell through to the region");
	assert.equal(r.ignored.length, 1);
	assert.equal(r.ignored[0]!.source, "team_fallback");
	assert.match(r.ignored[0]!.problem, /greater than zero/);
});

test("a team policy filed under another region is refused", () => {
	const misfiled: TeamSlaPolicy = {
		teamId: "ksa-support",
		regionId: "ksa",
		fallback: { firstResponseMinutes: 10, resolutionMinutes: 120 },
	};
	const r = resolveTarget("general", "normal", {
		teamIds: ["ksa-support"],
		regionId: "uae",
		teamPolicies: [misfiled],
		regionPolicies: [uaeRegion],
	});
	assert.equal(r.source, "region_fallback");
	assert.match(r.ignored[0]!.problem, /belongs to region ksa/);
});

test("resolution shorter than first response is a contradiction, not a policy", () => {
	assert.match(
		checkTarget({ firstResponseMinutes: 60, resolutionMinutes: 30 }) ?? "",
		/must not be shorter/,
	);
	assert.equal(
		checkTarget({ firstResponseMinutes: 30, resolutionMinutes: 30 }),
		null,
		"equal is allowed: answer it and close it",
	);
});

test("checkTarget rejects the shapes a bad import actually produces", () => {
	assert.match(checkTarget(null) ?? "", /not an object/);
	assert.match(checkTarget("5m") ?? "", /not an object/);
	assert.match(checkTarget({}) ?? "", /must be a number/);
	assert.match(
		checkTarget({ firstResponseMinutes: 1.5, resolutionMinutes: 60 }) ?? "",
		/whole number/,
	);
	assert.match(
		checkTarget({ firstResponseMinutes: 300000, resolutionMinutes: 300000 }) ??
			"",
		/longer than/,
		"milliseconds pasted into a minutes field",
	);
	assert.match(
		checkTarget({ firstResponseMinutes: NaN, resolutionMinutes: 60 }) ?? "",
		/must be a number/,
	);
});

/* ------------------------------------------------------------------ validation */

test("validateTeamPolicy refuses what resolveTarget would later ignore", () => {
	assert.deepEqual(validateTeamPolicy(uaeSupport), []);

	const errors = validateTeamPolicy({
		teamId: "",
		regionId: "uae",
		byType: { nonsense: { firstResponseMinutes: 5, resolutionMinutes: 10 } },
	} as unknown as TeamSlaPolicy);
	assert.ok(errors.some((e) => /teamId is required/.test(e)));
	assert.ok(errors.some((e) => /nonsense is not a ticket type/.test(e)));
});

test("an empty policy is reported rather than stored as a row that does nothing", () => {
	const errors = validateTeamPolicy({ teamId: "t", regionId: "uae" });
	assert.deepEqual(errors, ["policy sets no targets"]);
});

/* ---------------------------------------------------------------- Setup table */

test("the Setup table marks inherited rows apart from the team's own", () => {
	const rows = effectivePolicyTable({
		teamId: "uae-support",
		regionId: "uae",
		teamPolicies: [uaeSupport],
		regionPolicies: [uaeRegion],
	});
	const claim = rows.find((r) => r.type === "claim")!;
	const billing = rows.find((r) => r.type === "billing")!;

	assert.equal(claim.inherited, false);
	assert.equal(claim.source, "team_type");
	// The team's own fallback still counts as the team's, not inherited.
	assert.equal(billing.inherited, false);
	assert.equal(billing.source, "team_fallback");

	const unconfigured = effectivePolicyTable({
		teamId: "uae-nightshift",
		regionId: "uae",
		regionPolicies: [uaeRegion],
	});
	assert.ok(unconfigured.every((r) => r.inherited));
});
