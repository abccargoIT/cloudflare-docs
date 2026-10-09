import { test } from "node:test";
import assert from "node:assert/strict";
import {
	compileAudience,
	describeAudience,
	MAX_AUDIENCE,
	validateAudience,
	type AudienceRule,
} from "../src/broadcasts/audience.ts";
import {
	looksLikeLanguageCode,
	looksLikeTemplateName,
	parseTemplateComponents,
} from "../src/broadcasts/template.ts";
import { clampRate, parseAudience } from "../src/broadcasts/service.ts";

const NOW = new Date("2026-10-08T12:00:00.000Z");

const compile = (rule: AudienceRule, optedInOnly = false) =>
	compileAudience({ regionId: "uae", rule, optedInOnly, now: NOW });

/* ------------------------------------------------------- the exclusions */

test("an opt-out is excluded whether or not the rule says so", () => {
	// Not a filter, not overridable, and applied to service notices as well as
	// marketing. Added by the compiler so no audience can be written without it.
	for (const rule of [{}, { limit: 10 }, { customerIds: ["cus_1"] }]) {
		const { sql } = compile(rule);
		assert.match(sql, /NOT EXISTS \(SELECT 1 FROM contacts oc/);
		assert.match(sql, /oc\.opted_out = 1/);
	}
});

test("a customer with no WhatsApp number is excluded", () => {
	// So the resolved count is the number of messages that will actually go
	// out, rather than a figure that shrinks at send time.
	const { sql } = compile({});
	assert.match(sql, /c\.wa_id IS NOT NULL/);
	assert.match(sql, /TRIM\(c\.wa_id\) != ''/);
});

test("marketing requires an opt-in; a service notice does not", () => {
	assert.match(compile({}, true).sql, /c\.opt_in_marketing = 1/);
	assert.ok(!compile({}, false).sql.includes("opt_in_marketing"));
});

test("one row per number, not per customer record", () => {
	// `customers.wa_id` is already uniquely indexed, so this is belt and
	// braces rather than the guard that matters — it keeps the resolved count
	// honest if that index is ever relaxed. The guard that matters is the
	// primary key on (broadcast_id, wa_id), which makes a second message to
	// the same number impossible rather than unlikely.
	const { sql } = compile({});
	assert.match(sql, /GROUP BY c\.wa_id/);
});

/* ----------------------------------------------------------- the binding */

test("every value is bound, never written into the SQL", () => {
	// An audience rule arrives over the API from somebody composing a
	// campaign. A filter that could carry SQL into the query would be the
	// worst possible place for one.
	const nasty = "uae'; DROP TABLE customers; --";
	const { sql, bindings } = compileAudience({
		regionId: nasty,
		rule: {
			accountTypes: [],
			customerIds: ["cus'); DELETE FROM customers; --"],
		},
		optedInOnly: false,
		now: NOW,
	});
	assert.ok(!sql.includes("DROP TABLE"), sql);
	assert.ok(!sql.includes("DELETE FROM"), sql);
	assert.ok(bindings.includes(nasty));
	assert.ok(bindings.includes("cus'); DELETE FROM customers; --"));
	// Placeholders only, and one per binding plus the limit.
	const placeholders = [...sql.matchAll(/\?\d+/g)].map((m) => m[0]);
	assert.equal(new Set(placeholders).size, bindings.length);
});

test("the audience is capped even when the rule asks for more", () => {
	const { bindings } = compile({ limit: 999_999 });
	assert.equal(bindings[bindings.length - 1], MAX_AUDIENCE);
	const capped = compile({ limit: 50 });
	assert.equal(capped.bindings[capped.bindings.length - 1], 50);
});

/* ------------------------------------------------------------- filters */

test("shipped-within and not-shipped-within produce opposite conditions", () => {
	assert.match(
		compile({ bookedWithinDays: 30 }).sql,
		/\sEXISTS \(SELECT 1 FROM bookings/,
	);
	assert.match(
		compile({ notBookedWithinDays: 90 }).sql,
		/NOT EXISTS \(SELECT 1 FROM bookings/,
	);
});

test("an open-ticket filter works both ways round", () => {
	assert.match(
		compile({ hasOpenTicket: true }).sql,
		/\sEXISTS \(SELECT 1 FROM tickets/,
	);
	assert.match(
		compile({ hasOpenTicket: false }).sql,
		/NOT EXISTS \(SELECT 1 FROM tickets/,
	);
	// Absent means no condition at all, not "false".
	assert.ok(!compile({}).sql.includes("FROM tickets"));
});

/* ---------------------------------------------------------- validation */

test("both shipping windows at once is refused rather than silently narrowed", () => {
	// The two overlap and the audience comes back smaller than intended, or
	// empty, with nothing to explain it.
	const problems = validateAudience({
		bookedWithinDays: 30,
		notBookedWithinDays: 90,
	});
	assert.equal(problems.length, 1);
	assert.match(problems[0]?.message ?? "", /different audiences/);
});

test("nonsense filters are refused", () => {
	assert.ok(validateAudience({ bookedWithinDays: 0 }).length > 0);
	assert.ok(validateAudience({ bookedWithinDays: 1.5 }).length > 0);
	assert.ok(validateAudience({ notBookedWithinDays: 99_999 }).length > 0);
	assert.ok(validateAudience({ accountTypes: ["vip"] }).length > 0);
	assert.ok(validateAudience({ customerIds: [] }).length > 0);
	assert.ok(validateAudience({ limit: 0 }).length > 0);
	assert.ok(validateAudience({ limit: MAX_AUDIENCE + 1 }).length > 0);
	// A sensible rule passes.
	assert.deepEqual(
		validateAudience({
			accountTypes: ["business"],
			notBookedWithinDays: 90,
			limit: 500,
		}),
		[],
	);
});

/* ------------------------------------------------- the unreadable rule */

test("an unreadable audience rule reads as nothing, not as an empty filter", () => {
	// This is the one that matters most. Every field is a narrowing filter, so
	// an empty rule means every customer in the region — a default here would
	// message the lot.
	assert.equal(parseAudience("not json"), null);
	assert.equal(parseAudience("[1,2,3]"), null);
	assert.equal(parseAudience("null"), null);
	assert.deepEqual(parseAudience('{"limit":10}'), { limit: 10 });
});

/* ------------------------------------------------------- the description */

test("an approver can read what the audience is without reading JSON", () => {
	// An approval given against a rule nobody understood is not an approval.
	const text = describeAudience(
		{ accountTypes: ["business"], notBookedWithinDays: 90, limit: 500 },
		true,
	);
	assert.match(text, /opted in to marketing/);
	assert.match(text, /type business/);
	assert.match(text, /have not shipped in the last 90 days/);
	assert.match(text, /capped at 500/);
	// Stated every time, because it is the part somebody will be asked about.
	assert.match(text, /excluding anyone who has opted out/);
});

/* ---------------------------------------------------------- the template */

test("a template name Meta would reject is caught before the campaign is built", () => {
	// Otherwise one typo becomes five thousand rejections and a quality-rating
	// problem on the number.
	assert.equal(looksLikeTemplateName("shipment_delay_notice"), true);
	assert.equal(looksLikeTemplateName("Shipment_Delay"), false);
	assert.equal(looksLikeTemplateName("shipment delay"), false);
	assert.equal(looksLikeTemplateName(""), false);
	assert.equal(looksLikeLanguageCode("en"), true);
	assert.equal(looksLikeLanguageCode("en_US"), true);
	assert.equal(looksLikeLanguageCode("ar"), true);
	assert.equal(looksLikeLanguageCode("English"), false);
	assert.equal(looksLikeLanguageCode("en-us"), false);
});

test("a template with no variables is valid", () => {
	for (const input of [undefined, null, "[]", []]) {
		const parsed = parseTemplateComponents(input);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.ok === true && parsed.components, undefined);
	}
});

test("a well-formed components document is accepted", () => {
	const parsed = parseTemplateComponents([
		{ type: "body", parameters: [{ type: "text", text: "ABC-UAE-088210" }] },
		{
			type: "button",
			sub_type: "url",
			index: "0",
			parameters: [{ type: "text", text: "088210" }],
		},
	]);
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	assert.equal(parsed.ok === true && parsed.components?.length, 2);
});

test("a malformed components document is refused with the place named", () => {
	const bad = parseTemplateComponents([{ type: "footer", parameters: [] }]);
	assert.equal(bad.ok, false);
	assert.equal(bad.ok === false && bad.problems[0]?.where, "components[0]");

	// A button without its index is the common mistake, and Meta's rejection
	// for it is not self-explanatory.
	const noIndex = parseTemplateComponents([{ type: "button", parameters: [] }]);
	assert.equal(noIndex.ok, false);
	assert.match(
		noIndex.ok === false ? (noIndex.problems[0]?.message ?? "") : "",
		/index/,
	);

	// A text parameter with no text.
	const noText = parseTemplateComponents([
		{ type: "body", parameters: [{ type: "text" }] },
	]);
	assert.equal(noText.ok, false);

	assert.equal(parseTemplateComponents("{not json").ok, false);
	assert.equal(parseTemplateComponents({ type: "body" }).ok, false);
});

/* --------------------------------------------------------------- pacing */

test("the send rate is held inside bounds that protect the number", () => {
	assert.equal(clampRate(undefined), 20);
	assert.equal(clampRate(0), 1);
	assert.equal(clampRate(-5), 1);
	assert.equal(clampRate(1000), 120);
	assert.equal(clampRate(30), 30);
	assert.equal(clampRate(Number.NaN), 20);
});
