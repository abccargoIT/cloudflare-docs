/**
 * The report library: named reports, the series behind each chart, and export.
 *
 * The design package asks for charts, a library of saved reports and an export.
 * A regional summary already existed; what was missing was a way to name a
 * report, hand it the same window every time, and take it away as a file.
 *
 * Three decisions shape this file.
 *
 * **A report is a definition, not a screen.** Each entry below says what it
 * counts, how it groups and which columns it exports. The screen renders
 * whatever the definition says, so adding a report is a data change rather
 * than another block of markup, and the CSV and the chart cannot disagree
 * about what the report contains — they are built from the same rows.
 *
 * **Export escapes for the spreadsheet, not just for CSV.** A field beginning
 * `=`, `+`, `-`, `@`, tab or carriage return is treated as a formula by Excel
 * and by Google Sheets when the file is opened. A customer who calls
 * themselves `=1+1` is harmless; `=HYPERLINK(...)` in a shipment reference is
 * not, and a cargo reference legitimately starts with a dash. So those fields
 * are prefixed with an apostrophe, which spreadsheets strip on display. This
 * is a known CSV injection route and the one security concern an export has.
 *
 * **A report that cannot be computed is absent rather than estimated.** Same
 * rule as the rest of the platform: no filler figures.
 */

import type { TicketType } from "./types.ts";

/** A closed interval. Re-declared loosely so this file stays free of the DB. */
export interface ReportWindow {
	from: string;
	to: string;
}

export type ReportGroup = "region" | "day" | "ticket_type" | "score" | "agent";

export interface ReportColumn {
	key: string;
	label: string;
	/** Right-align and monospace in the UI; unquoted in CSV where possible. */
	numeric?: boolean;
}

export interface ReportDefinition {
	id: string;
	title: string;
	/** One line, shown under the title in the library. */
	description: string;
	group: ReportGroup;
	columns: ReportColumn[];
	/**
	 * Which form the screen should use. `none` means the numbers are the
	 * point and a chart would only decorate them.
	 */
	chart: "column" | "small_multiples" | "none";
	/** Who may run it. Reports are a supervisor view; see auth/policy.ts. */
	supervisorOnly: boolean;
}

/**
 * The library.
 *
 * Deliberately short. Each of these answers a question somebody actually
 * asked during the Freshworks review; a library of forty reports nobody opens
 * is how reporting screens die.
 */
export const REPORT_LIBRARY: ReportDefinition[] = [
	{
		id: "volume_by_day",
		title: "Conversation volume by day",
		description:
			"New conversations per day, per region. Shows whether a number is getting busier.",
		group: "day",
		columns: [
			{ key: "day", label: "Day" },
			{ key: "regionId", label: "Region" },
			{ key: "conversations", label: "Conversations", numeric: true },
		],
		chart: "small_multiples",
		supervisorOnly: true,
	},
	{
		id: "first_response",
		title: "First response against target",
		description:
			"How many first replies landed inside the service target, by region. On the live platform the target is the ticket's.",
		group: "region",
		columns: [
			{ key: "regionId", label: "Region" },
			{ key: "answered", label: "Answered", numeric: true },
			{ key: "withinTarget", label: "Within target", numeric: true },
			{ key: "late", label: "Late", numeric: true },
			{ key: "unanswered", label: "Still waiting", numeric: true },
		],
		chart: "none",
		supervisorOnly: true,
	},
	{
		id: "tickets_by_type",
		title: "Tickets by type",
		description:
			"What customers actually raise, which is what staffing should follow.",
		group: "ticket_type",
		columns: [
			{ key: "type", label: "Type" },
			{ key: "opened", label: "Opened", numeric: true },
			{ key: "resolved", label: "Resolved", numeric: true },
			{ key: "overdue", label: "Overdue", numeric: true },
		],
		chart: "column",
		supervisorOnly: true,
	},
	{
		id: "csat_distribution",
		title: "Satisfaction distribution",
		description:
			"The spread of scores, not just the mean. A 4.4 made of fives and ones is not a 4.4.",
		group: "score",
		columns: [
			{ key: "score", label: "Score" },
			{ key: "responses", label: "Responses", numeric: true },
		],
		chart: "column",
		supervisorOnly: true,
	},
];

export function findReport(id: string): ReportDefinition | undefined {
	return REPORT_LIBRARY.find((r) => r.id === id);
}

/* ------------------------------------------------------------------ series */

export interface SeriesPoint {
	label: string;
	value: number;
}

export interface Series {
	/** The panel or series name, e.g. a region label. */
	name: string;
	points: SeriesPoint[];
}

/**
 * Turns report rows into one series per panel.
 *
 * `panelKey` names the column that splits the small multiples; omit it for a
 * single series. The rows' order is preserved, because for a day series the
 * order *is* the x-axis and re-sorting by value would silently turn a trend
 * into a ranking.
 */
export function toSeries(
	rows: Array<Record<string, unknown>>,
	labelKey: string,
	valueKey: string,
	panelKey?: string,
): Series[] {
	const panels = new Map<string, SeriesPoint[]>();
	for (const row of rows) {
		const name = panelKey ? String(row[panelKey] ?? "") : "";
		const raw = row[valueKey];
		const value = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
		const point = { label: String(row[labelKey] ?? ""), value };
		const list = panels.get(name);
		if (list) list.push(point);
		else panels.set(name, [point]);
	}
	return [...panels.entries()].map(([name, points]) => ({ name, points }));
}

/**
 * A y-axis maximum that lands on a round number at or above the data.
 *
 * Returns at least 1 so an all-zero series still has a drawable axis rather
 * than dividing by zero and producing bars of infinite height.
 */
export function niceMax(values: number[]): number {
	const peak = Math.max(0, ...values.filter((v) => Number.isFinite(v)));
	if (peak <= 0) return 1;
	const magnitude = 10 ** Math.floor(Math.log10(peak));
	for (const step of [1, 2, 2.5, 5, 10]) {
		const candidate = magnitude * step;
		if (candidate >= peak) return candidate;
	}
	return magnitude * 10;
}

/* ------------------------------------------------------------------ export */

/** Characters a spreadsheet will read as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Escapes one field for CSV, and defuses spreadsheet formula injection.
 *
 * The apostrophe prefix is what spreadsheets use to mean "this is text"; they
 * strip it on display, so the cell still reads as the original value. It is
 * applied before quoting so the quote wraps the whole literal.
 */
export function csvField(value: unknown): string {
	let text =
		value === null || value === undefined
			? ""
			: typeof value === "number" && !Number.isFinite(value)
				? ""
				: String(value);

	if (FORMULA_START.test(text)) text = `'${text}`;

	// Quote when the field contains anything that would otherwise break the
	// row, and double any embedded quote.
	if (/["\n\r,;]/.test(text)) {
		return `"${text.replace(/"/g, '""')}"`;
	}
	return text;
}

/**
 * Builds the CSV for one report.
 *
 * CRLF line endings and a UTF-8 BOM, both for Excel: without the BOM it reads
 * the file as the system codepage and an Arabic customer name arrives as
 * mojibake, which is the single most common complaint about an export.
 */
export function toCsv(
	definition: ReportDefinition,
	rows: Array<Record<string, unknown>>,
	options: { bom?: boolean } = {},
): string {
	const header = definition.columns.map((c) => csvField(c.label)).join(",");
	const body = rows.map((row) =>
		definition.columns.map((c) => csvField(row[c.key])).join(","),
	);
	const text = [header, ...body].join("\r\n");
	return options.bom === false ? text : `\uFEFF${text}`;
}

/**
 * A filename that is safe on Windows, which is where these land.
 *
 * Colons from an ISO timestamp are illegal in a Windows filename and silently
 * break the download, so the window is rendered as dates only.
 */
export function exportFilename(
	definition: ReportDefinition,
	window: ReportWindow,
): string {
	const day = (iso: string) => (iso || "").slice(0, 10) || "unknown";
	const safeId = definition.id.replace(/[^a-z0-9_-]/gi, "-");
	return `abc-cargo-${safeId}-${day(window.from)}-to-${day(window.to)}.csv`;
}

/* ------------------------------------------------------- row construction */

export interface TicketTypeRow {
	type: TicketType;
	opened: number;
	resolved: number;
	overdue: number;
}

/**
 * The satisfaction distribution as report rows, all five scores present.
 *
 * A score nobody gave is a zero row rather than a missing one: a distribution
 * with 2 absent reads as though 2 were impossible.
 */
export function csatDistributionRows(
	distribution: Record<number, number>,
): Array<{ score: string; responses: number }> {
	return [1, 2, 3, 4, 5].map((score) => ({
		score: String(score),
		responses: distribution[score] ?? 0,
	}));
}
