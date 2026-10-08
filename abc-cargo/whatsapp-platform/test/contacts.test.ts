import { test } from "node:test";
import assert from "node:assert/strict";
import { Contacts, isCustomerStage } from "../src/crm/contacts.ts";

const NOW = new Date("2026-10-08T12:00:00Z");
const daysAgo = (days: number) =>
	new Date(NOW.getTime() - days * 86_400_000).toISOString();

interface Tables {
	customers: Record<string, unknown>[];
	leads: Record<string, unknown>[];
	quotations: Record<string, unknown>[];
	bookings: Record<string, unknown>[];
}

/**
 * A D1 stand-in that returns canned rows and counts how many statements were
 * prepared. The count is the point of several tests below: the lifecycle is
 * derived per customer, so the obvious implementation would query per customer
 * too, and that is exactly what must not happen.
 */
function fakeDb(tables: Tables) {
	const log: string[] = [];
	const db = {
		prepare(sql: string) {
			log.push(sql);
			return {
				bind(...params: unknown[]) {
					return {
						async all<T>() {
							if (sql.includes("FROM customers")) {
								const regionId = params[0];
								const search =
									typeof params[1] === "string" && params[1].includes("%")
										? String(params[1]).replace(/%/g, "").toLowerCase()
										: null;
								let rows = tables.customers.filter(
									(c) => c.region_id === regionId,
								);
								if (search) {
									rows = rows.filter((c) =>
										String(c.display_name ?? "")
											.toLowerCase()
											.includes(search),
									);
								}
								return { results: rows as T[] };
							}
							const ids = new Set(params.map(String));
							const source = sql.includes("FROM leads")
								? tables.leads
								: sql.includes("FROM quotations")
									? tables.quotations
									: tables.bookings;
							return {
								results: source.filter((row) =>
									ids.has(String(row.customer_id)),
								) as T[],
							};
						},
					};
				},
			};
		},
	};
	return { db: db as unknown as D1Database, log };
}

function customer(id: string, name: string, regionId = "uae") {
	return {
		id,
		display_name: name,
		region_id: regionId,
		updated_at: daysAgo(1),
		wa_id: null,
		phone: null,
		email: null,
	};
}

/* ------------------------------------------------------------------- list */

test("every contact carries its derived lifecycle", async () => {
	const { db } = fakeDb({
		customers: [
			customer("c_shipper", "Rashid Al Marzooqi"),
			customer("c_enquiry", "New Enquirer"),
			customer("c_quiet", "Quiet Prospect"),
		],
		leads: [
			{
				customer_id: "c_enquiry",
				stage: "negotiating",
				updated_at: daysAgo(1),
			},
		],
		quotations: [],
		bookings: [
			{
				customer_id: "c_shipper",
				milestone: "delivered",
				created_at: daysAgo(20),
			},
		],
	});

	const { contacts } = await new Contacts(db).list({ regionIds: ["uae"] }, NOW);
	const byId = new Map(contacts.map((c) => [c.customer.id, c]));

	assert.equal(byId.get("c_shipper")?.lifecycle.stage, "customer");
	assert.equal(byId.get("c_enquiry")?.lifecycle.stage, "engaged");
	assert.equal(byId.get("c_quiet")?.lifecycle.stage, "prospect");
	// The record counts come from the same fetch, not a second one.
	assert.equal(byId.get("c_shipper")?.counts.bookings, 1);
	assert.equal(byId.get("c_enquiry")?.counts.leads, 1);
	assert.equal(byId.get("c_quiet")?.counts.leads, 0);
});

test("a page of contacts costs four queries, not four per contact", async () => {
	// The claim this file exists to defend. Fifty contacts deriving from three
	// tables each would be a hundred and fifty queries done the obvious way.
	const customers = Array.from({ length: 50 }, (_, i) =>
		customer(`c_${i}`, `Customer ${i}`),
	);
	const { db, log } = fakeDb({
		customers,
		leads: customers.map((c) => ({
			customer_id: c.id,
			stage: "new",
			updated_at: daysAgo(2),
		})),
		quotations: [],
		bookings: [],
	});

	const { contacts } = await new Contacts(db).list(
		{ regionIds: ["uae"], limit: 50 },
		NOW,
	);
	assert.equal(contacts.length, 50);
	// One for the customers, one each for leads, quotations and bookings.
	assert.equal(log.length, 4, log.join("\n"));
});

test("a long page is chunked rather than bound as one enormous IN list", async () => {
	// D1 binds parameters individually, so an unbounded IN list is refused.
	const customers = Array.from({ length: 200 }, (_, i) =>
		customer(`c_${i}`, `Customer ${i}`),
	);
	const { db, log } = fakeDb({
		customers,
		leads: [],
		quotations: [],
		bookings: [],
	});

	await new Contacts(db).list({ regionIds: ["uae"], limit: 200 }, NOW);
	// 200 ids at 80 per chunk is three chunks per table, plus the customers.
	assert.equal(log.length, 1 + 3 * 3, String(log.length));
});

test("an empty region list returns nothing and touches the database not at all", async () => {
	// The failure that matters: no regions read as "no filter" and therefore
	// as every region.
	const { db, log } = fakeDb({
		customers: [customer("c_1", "Someone")],
		leads: [],
		quotations: [],
		bookings: [],
	});
	const page = await new Contacts(db).list({ regionIds: [] }, NOW);
	assert.deepEqual(page.contacts, []);
	assert.equal(log.length, 0);
});

test("the stage filter is applied after derivation, and says what it scanned", async () => {
	const { db } = fakeDb({
		customers: [customer("c_a", "Shipper"), customer("c_b", "Enquirer")],
		leads: [{ customer_id: "c_b", stage: "new", updated_at: daysAgo(1) }],
		quotations: [],
		bookings: [
			{ customer_id: "c_a", milestone: "delivered", created_at: daysAgo(5) },
		],
	});

	const page = await new Contacts(db).list(
		{ regionIds: ["uae"], stage: "customer" },
		NOW,
	);
	assert.equal(page.contacts.length, 1);
	assert.equal(page.contacts[0]?.customer.id, "c_a");
	// Scanned reports what was examined, so a thin page is distinguishable
	// from a page nobody matched.
	assert.equal(page.scanned, 2);
});

test("search narrows by name", async () => {
	const { db } = fakeDb({
		customers: [
			customer("c_a", "Rashid Al Marzooqi"),
			customer("c_b", "Daniel Okoye"),
		],
		leads: [],
		quotations: [],
		bookings: [],
	});
	const page = await new Contacts(db).list(
		{ regionIds: ["uae"], search: "okoye" },
		NOW,
	);
	assert.equal(page.contacts.length, 1);
	assert.equal(page.contacts[0]?.customer.display_name, "Daniel Okoye");
});

/* ------------------------------------------------------------------ board */

test("the board shows every stage, including the empty ones", async () => {
	// A board that hides empty columns changes shape as the data moves, and a
	// missing column reads as a stage that does not exist rather than one
	// nobody is in.
	const { db } = fakeDb({
		customers: [customer("c_a", "Only Contact")],
		leads: [],
		quotations: [],
		bookings: [],
	});
	const board = await new Contacts(db).board(["uae"], {}, NOW);
	assert.equal(board.columns.length, 8);
	const prospect = board.columns.find((c) => c.stage === "prospect");
	assert.equal(prospect?.total, 1);
	for (const column of board.columns) {
		assert.ok(column.label.length > 0, column.stage);
	}
});

test("an empty column reads the same as a full one", async () => {
	// The labels must come from one place; deriving a fallback separately is
	// how "New lead" quietly becomes "Lead" when nobody is in it.
	const { db } = fakeDb({
		customers: [
			customer("c_a", "Enquirer"),
			customer("c_b", "Another Enquirer"),
		],
		leads: [
			{ customer_id: "c_a", stage: "new", updated_at: daysAgo(90) },
			{ customer_id: "c_b", stage: "new", updated_at: daysAgo(90) },
		],
		quotations: [],
		bookings: [],
	});
	const board = await new Contacts(db).board(["uae"], {}, NOW);
	const populated = board.columns.find((c) => c.stage === "lead");
	const empty = board.columns.find((c) => c.stage === "dormant");
	assert.equal(populated?.label, "New lead");
	assert.equal(populated?.total, 2);
	assert.equal(empty?.total, 0);
	assert.equal(empty?.label, "Dormant");
});

test("a column is ordered warmest first, and capped", async () => {
	const customers = Array.from({ length: 6 }, (_, i) =>
		customer(`c_${i}`, `Enquirer ${i}`),
	);
	const { db } = fakeDb({
		customers,
		// Ascending staleness, so the warmest is c_0.
		leads: customers.map((c, i) => ({
			customer_id: c.id,
			stage: "negotiating",
			updated_at: daysAgo(i),
		})),
		quotations: [],
		bookings: [],
	});

	const board = await new Contacts(db).board(["uae"], { perColumn: 3 }, NOW);
	const engaged = board.columns.find((c) => c.stage === "engaged");
	assert.equal(engaged?.total, 6);
	assert.equal(engaged?.top.length, 3);
	const temps = engaged?.top.map((c) => c.lifecycle.temperature) ?? [];
	assert.deepEqual(
		[...temps].sort((a, b) => b - a),
		temps,
	);
});

test("stage names from a query string are validated, not trusted", () => {
	assert.equal(isCustomerStage("customer"), true);
	assert.equal(isCustomerStage("repeat_customer"), true);
	assert.equal(isCustomerStage("vip"), false);
	assert.equal(isCustomerStage(""), false);
});
