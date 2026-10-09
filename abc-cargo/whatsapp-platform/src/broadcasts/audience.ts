/**
 * Choosing who a broadcast goes to.
 *
 * Two rules govern this file.
 *
 * **Every value is bound, never interpolated.** The only things written into
 * the SQL text are placeholder numbers and column names from a fixed list in
 * this file. An audience rule arrives over the API, from somebody composing a
 * campaign, and a filter that could carry SQL into the query would be the
 * worst possible place for one.
 *
 * **The exclusions are not optional.** An opt-out is honoured absolutely, for
 * marketing and service alike, and a customer with no WhatsApp id cannot be
 * messaged on WhatsApp. Those two conditions are added by the compiler rather
 * than by the rule, so no audience can be written that omits them.
 *
 * What is deliberately *not* supported is filtering by derived lifecycle stage.
 * A stage is computed from a customer's leads, quotations and shipments rather
 * than stored, so it cannot be a SQL condition without duplicating the
 * derivation here — and two implementations of "who counts as dormant" is
 * exactly how a reactivation campaign reaches the wrong people. The filters
 * below answer the same questions directly: who has not shipped in ninety
 * days, who has an open ticket.
 */

export interface AudienceRule {
	/** Account types to include. Empty or absent means all of them. */
	accountTypes?: string[];
	/** Only customers who have shipped within this many days. */
	bookedWithinDays?: number;
	/** Only customers who have *not* shipped within this many days. */
	notBookedWithinDays?: number;
	/** Narrow to, or exclude, customers with an unresolved ticket. */
	hasOpenTicket?: boolean;
	/** An explicit list, which is also how a test send names its recipients. */
	customerIds?: string[];
	/** A cap on the audience, as a stated safety limit rather than a filter. */
	limit?: number;
}

export interface AudienceProblem {
	field: string;
	message: string;
}

/**
 * The largest audience the platform will resolve in one broadcast.
 *
 * Not a technical limit. A campaign bigger than this to a single WhatsApp
 * number will be throttled by Meta and will drag that number's quality rating
 * down, which affects every ordinary customer conversation on it. Somebody
 * should have to split it deliberately.
 */
export const MAX_AUDIENCE = 10_000;

/** Account types a rule may name, so an unknown one is a mistake not a filter. */
export const KNOWN_ACCOUNT_TYPES = [
	"individual",
	"business",
	"agent",
	"corporate",
] as const;

export function validateAudience(rule: AudienceRule): AudienceProblem[] {
	const problems: AudienceProblem[] = [];
	const positiveDays = (value: number | undefined, field: string) => {
		if (value === undefined) return;
		if (!Number.isInteger(value) || value < 1 || value > 3650) {
			problems.push({
				field,
				message: "must be a whole number of days between 1 and 3650",
			});
		}
	};
	positiveDays(rule.bookedWithinDays, "bookedWithinDays");
	positiveDays(rule.notBookedWithinDays, "notBookedWithinDays");

	// Both at once is almost always a mistake, and it is a silent one: the two
	// windows overlap and the audience comes back smaller than anybody
	// intended, or empty.
	if (
		rule.bookedWithinDays !== undefined &&
		rule.notBookedWithinDays !== undefined
	) {
		problems.push({
			field: "bookedWithinDays",
			message:
				"shipped-within and not-shipped-within cannot both be set; they describe different audiences",
		});
	}

	for (const type of rule.accountTypes ?? []) {
		if (!(KNOWN_ACCOUNT_TYPES as readonly string[]).includes(type)) {
			problems.push({
				field: "accountTypes",
				message: `"${type}" is not an account type this platform records`,
			});
		}
	}

	if (rule.customerIds !== undefined) {
		if (rule.customerIds.length === 0) {
			problems.push({
				field: "customerIds",
				message: "an explicit list cannot be empty; leave it out instead",
			});
		}
		if (rule.customerIds.length > 500) {
			problems.push({
				field: "customerIds",
				message: "an explicit list is limited to 500; use filters above that",
			});
		}
	}

	if (rule.limit !== undefined) {
		if (!Number.isInteger(rule.limit) || rule.limit < 1) {
			problems.push({
				field: "limit",
				message: "must be a positive whole number",
			});
		} else if (rule.limit > MAX_AUDIENCE) {
			problems.push({
				field: "limit",
				message: `the most this platform will send in one broadcast is ${MAX_AUDIENCE}`,
			});
		}
	}

	return problems;
}

export interface CompiledAudience {
	sql: string;
	bindings: (string | number)[];
}

/**
 * The query that finds the audience, and the exclusions nobody can omit.
 *
 * `optedInOnly` is decided by the broadcast's kind, not by the rule: marketing
 * requires an opt-in, a service notice about a shipment the customer asked us
 * to carry does not. Neither may reach somebody who has opted out.
 */
export function compileAudience(input: {
	regionId: string;
	rule: AudienceRule;
	optedInOnly: boolean;
	now: Date;
}): CompiledAudience {
	const bindings: (string | number)[] = [];
	const bind = (value: string | number): string => {
		bindings.push(value);
		return `?${bindings.length}`;
	};

	const conditions: string[] = [`c.region_id = ${bind(input.regionId)}`];

	// A customer with no WhatsApp id cannot be messaged on WhatsApp. Included
	// as a condition rather than left to the sender so the resolved count is
	// the number of messages that will actually go out.
	conditions.push(`c.wa_id IS NOT NULL AND TRIM(c.wa_id) != ''`);

	// An opt-out is absolute. Not a filter, not overridable, and applied to
	// service notices as well as marketing.
	conditions.push(
		`NOT EXISTS (SELECT 1 FROM contacts oc
		   WHERE oc.wa_id = c.wa_id AND oc.opted_out = 1)`,
	);

	if (input.optedInOnly) {
		conditions.push(`c.opt_in_marketing = 1`);
	}

	const types = input.rule.accountTypes ?? [];
	if (types.length > 0) {
		conditions.push(
			`c.account_type IN (${types.map((t) => bind(t)).join(", ")})`,
		);
	}

	const ids = input.rule.customerIds ?? [];
	if (ids.length > 0) {
		conditions.push(`c.id IN (${ids.map((id) => bind(id)).join(", ")})`);
	}

	if (input.rule.bookedWithinDays !== undefined) {
		conditions.push(
			`EXISTS (SELECT 1 FROM bookings b
			   WHERE b.customer_id = c.id
			     AND b.created_at >= ${bind(daysAgo(input.now, input.rule.bookedWithinDays))})`,
		);
	}

	if (input.rule.notBookedWithinDays !== undefined) {
		conditions.push(
			`NOT EXISTS (SELECT 1 FROM bookings b
			   WHERE b.customer_id = c.id
			     AND b.created_at >= ${bind(daysAgo(input.now, input.rule.notBookedWithinDays))})`,
		);
	}

	if (input.rule.hasOpenTicket !== undefined) {
		const exists = input.rule.hasOpenTicket ? "EXISTS" : "NOT EXISTS";
		conditions.push(
			`${exists} (SELECT 1 FROM tickets t
			   WHERE t.customer_id = c.id AND t.status IN ('open','pending'))`,
		);
	}

	// One row per WhatsApp id, not per customer record. Two records for the
	// same number must not produce two messages to that number — the recipient
	// key enforces that too, but doing it here keeps the resolved count honest.
	const limit = Math.min(input.rule.limit ?? MAX_AUDIENCE, MAX_AUDIENCE);
	const sql = `SELECT c.wa_id AS wa_id, MIN(c.id) AS customer_id
		 FROM customers c
		 WHERE ${conditions.join("\n		   AND ")}
		 GROUP BY c.wa_id
		 ORDER BY c.wa_id
		 LIMIT ${bind(limit)}`;

	return { sql, bindings };
}

function daysAgo(now: Date, days: number): string {
	return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/**
 * A short description of an audience, for the approval screen.
 *
 * Whoever approves a broadcast should be able to read what was asked for
 * without reading JSON, because an approval given against a rule nobody
 * understood is not an approval.
 */
export function describeAudience(
	rule: AudienceRule,
	optedInOnly: boolean,
): string {
	const parts: string[] = [];
	parts.push(optedInOnly ? "customers who opted in to marketing" : "customers");
	if ((rule.accountTypes ?? []).length > 0) {
		parts.push(`of type ${(rule.accountTypes ?? []).join(" or ")}`);
	}
	if (rule.bookedWithinDays !== undefined) {
		parts.push(`who shipped in the last ${rule.bookedWithinDays} days`);
	}
	if (rule.notBookedWithinDays !== undefined) {
		parts.push(
			`who have not shipped in the last ${rule.notBookedWithinDays} days`,
		);
	}
	if (rule.hasOpenTicket === true) parts.push("with an open ticket");
	if (rule.hasOpenTicket === false) parts.push("with no open ticket");
	if ((rule.customerIds ?? []).length > 0) {
		parts.push(`from a named list of ${(rule.customerIds ?? []).length}`);
	}
	if (rule.limit !== undefined) parts.push(`capped at ${rule.limit}`);
	// Stated every time, because it is the part somebody will be asked about.
	parts.push("excluding anyone who has opted out");
	return parts.join(", ");
}
