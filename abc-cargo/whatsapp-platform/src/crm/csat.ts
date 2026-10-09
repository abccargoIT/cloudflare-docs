/**
 * Customer satisfaction: asking, scoring, and refusing to publish a figure
 * that cannot carry weight.
 *
 * The designed dashboard shows "CSAT 4.4/5". Nothing in the platform measured
 * it, so the tile was left empty rather than filled with a plausible number.
 * This module is what fills it honestly.
 *
 * Three rules shape the file, and the third is the point of it.
 *
 * **The survey is a business-initiated message**, so it obeys the same two
 * constraints as any other: outside the 24-hour service window it can only be
 * an approved template, and a customer who has opted out is not surveyed. A
 * service survey is not marketing, but it is still ABC Cargo choosing to
 * message somebody who did not ask to be messaged.
 *
 * **Nobody gets surveyed twice**, and nobody gets surveyed repeatedly across
 * conversations. Survey fatigue depresses the response rate, and a falling
 * response rate quietly biases the score toward whoever is still bothering to
 * answer.
 *
 * **A mean is never reported without the count and the response rate beside
 * it.** 4.4 from three replies out of two hundred resolutions is not a
 * satisfaction score, it is three opinions. `summarise` therefore returns
 * `reportable: false` below a minimum sample and the dashboard shows a gap,
 * because the whole reason this tile was empty was to avoid a figure nobody
 * can trace.
 *
 * What is deliberately absent: any way to exclude a conversation from the
 * survey on the grounds that it went badly. Eligibility turns on channel
 * constraints, consent and fatigue — never on the outcome, the ticket type or
 * the agent. A score you can shape by choosing who to ask is worse than no
 * score.
 */

/** The 1-5 scale the designs use. */
export const CSAT_MIN = 1;
export const CSAT_MAX = 5;

/** Below this many responses a mean is not published. */
export const MIN_REPORTABLE_RESPONSES = 10;

/** Days before the same customer may be surveyed again. */
export const SURVEY_COOLDOWN_DAYS = 30;

/** How long a sent survey stays answerable. */
export const SURVEY_OPEN_HOURS = 72;

export type SurveyChannel = "free_text" | "template";

export interface SurveyEligibilityInput {
	conversationId: string;
	customerId: string;
	/** Resolution instant. A survey is only ever sent after resolution. */
	resolvedAt: string | null;
	/** Whether this conversation has already had a survey sent. */
	alreadySurveyed: boolean;
	/** The last survey sent to this customer on any conversation. */
	lastSurveyedCustomerAt?: string | null;
	/** Marketing/non-essential opt-out. */
	optedOut: boolean;
	/** 24-hour service window close, if it is open. */
	windowExpiresAt?: string | null;
	/** Whether an approved survey template exists for the region's language. */
	templateAvailable: boolean;
	/** A customer with no reachable number cannot be asked. */
	hasPhone: boolean;
}

export type SurveyRefusal =
	| "not_resolved"
	| "already_surveyed"
	| "cooldown"
	| "opted_out"
	| "no_phone"
	| "no_template_outside_window";

export type SurveyDecision =
	| { send: true; channel: SurveyChannel }
	| { send: false; refusal: SurveyRefusal; message: string };

const DAY_MS = 86_400_000;

/**
 * Whether to ask this customer, and how the question can legally be sent.
 *
 * Returns the channel as well as the yes, because inside the window a plain
 * message is enough and outside it a template is mandatory — and the caller
 * must not have to re-derive that.
 */
export function shouldSendSurvey(
	input: SurveyEligibilityInput,
	now: Date = new Date(),
): SurveyDecision {
	if (!input.resolvedAt) {
		return refuse("not_resolved", "The conversation is not resolved yet.");
	}
	if (input.alreadySurveyed) {
		return refuse(
			"already_surveyed",
			"This conversation was already surveyed.",
		);
	}
	if (input.optedOut) {
		return refuse("opted_out", "This customer has opted out of messages.");
	}
	if (!input.hasPhone) {
		return refuse("no_phone", "No reachable number for this customer.");
	}

	const last = input.lastSurveyedCustomerAt
		? Date.parse(input.lastSurveyedCustomerAt)
		: null;
	if (last !== null && Number.isFinite(last)) {
		const daysSince = (now.getTime() - last) / DAY_MS;
		if (daysSince < SURVEY_COOLDOWN_DAYS) {
			return refuse(
				"cooldown",
				`Surveyed ${Math.floor(daysSince)} days ago; the cooldown is ${SURVEY_COOLDOWN_DAYS} days.`,
			);
		}
	}

	const windowOpen =
		!!input.windowExpiresAt &&
		Date.parse(input.windowExpiresAt) > now.getTime();

	if (windowOpen) return { send: true, channel: "free_text" };
	if (input.templateAvailable) return { send: true, channel: "template" };

	return refuse(
		"no_template_outside_window",
		"The service window has closed and no approved survey template is available.",
	);
}

function refuse(refusal: SurveyRefusal, message: string): SurveyDecision {
	return { send: false, refusal, message };
}

/* --------------------------------------------------------------- answering */

export interface SurveyResponse {
	score: number;
	/** Anything the customer wrote beyond the number. */
	comment: string | null;
}

/** Arabic-Indic and Eastern Arabic-Indic digits, as a real handset sends them. */
const EASTERN_DIGITS: Record<string, string> = {
	"٠": "0",
	"١": "1",
	"٢": "2",
	"٣": "3",
	"٤": "4",
	"٥": "5",
	"٦": "6",
	"٧": "7",
	"٨": "8",
	"٩": "9",
	"۰": "0",
	"۱": "1",
	"۲": "2",
	"۳": "3",
	"۴": "4",
	"۵": "5",
	"۶": "6",
	"۷": "7",
	"۸": "8",
	"۹": "9",
};

function westernise(text: string): string {
	return text.replace(/[٠-٩۰-۹]/g, (d) => EASTERN_DIGITS[d] ?? d);
}

/**
 * Reads a score out of whatever the customer actually sent.
 *
 * The survey offers quick-reply buttons, and a button press arrives as a
 * payload we chose — `csat:4` — which is unambiguous. But customers type as
 * well: "5", "5/5", "٤", "4 - good service, thanks". All of those are a
 * score and a comment, and throwing them away to insist on a button press
 * loses real responses and biases the sample toward the button-pressers.
 *
 * Anything that is not a score returns null, and the caller treats it as an
 * ordinary message: a customer replying "actually I have another question"
 * to a survey is starting a conversation, not rating one.
 */
export function parseSurveyReply(
	raw: string,
	buttonPayload?: string | null,
): SurveyResponse | null {
	if (buttonPayload) {
		const match = /^csat:([1-5])$/.exec(buttonPayload.trim());
		if (match) return { score: Number(match[1]), comment: null };
	}

	const text = westernise((raw ?? "").trim());
	if (!text) return null;

	// A leading score, optionally "n/5", optionally followed by a comment.
	const leading = /^([1-5])\s*(?:\/\s*5)?\b[\s.,:;!-]*(.*)$/s.exec(text);
	if (leading) {
		const comment = leading[2]!.trim();
		return { score: Number(leading[1]), comment: comment || null };
	}

	// A bare score anywhere in a very short reply: "it's a 5".
	if (text.length <= 24) {
		const anywhere = /(?:^|\s)([1-5])(?:\s*\/\s*5)?(?:$|\s|[.!])/.exec(text);
		if (anywhere) {
			return { score: Number(anywhere[1]), comment: text };
		}
	}

	return null;
}

/** Whether a sent survey is still open for an answer. */
export function surveyStillOpen(
	sentAt: string,
	now: Date = new Date(),
): boolean {
	const sent = Date.parse(sentAt);
	if (!Number.isFinite(sent)) return false;
	return now.getTime() - sent < SURVEY_OPEN_HOURS * 3_600_000;
}

/* -------------------------------------------------------------- reporting */

export interface CsatRecord {
	score: number;
	regionId: string;
	/** The agent who resolved it, where one did. */
	agentId?: string | null;
	respondedAt: string;
}

export interface CsatSummary {
	/** Surveys sent in the window. */
	sent: number;
	responses: number;
	/** Responses divided by sent, 0-1, or null when nothing was sent. */
	responseRate: number | null;
	/** Mean score, or null when there is nothing worth averaging. */
	mean: number | null;
	/** Count per score, 1-5, always all five keys. */
	distribution: Record<number, number>;
	/**
	 * Whether the mean may be shown as a figure.
	 *
	 * False means "show a gap, not a number" — the dashboard prints the
	 * response count instead, which is the honest thing to print.
	 */
	reportable: boolean;
	/** Why it is not reportable, for the tooltip. */
	note: string | null;
}

export function summarise(
	records: CsatRecord[],
	sent: number,
	minResponses: number = MIN_REPORTABLE_RESPONSES,
): CsatSummary {
	const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
	let total = 0;
	let counted = 0;

	for (const record of records) {
		const score = record.score;
		if (!Number.isInteger(score) || score < CSAT_MIN || score > CSAT_MAX) {
			// A score outside the scale is a bug upstream, not a data point to
			// average. Dropped, and not counted as a response either.
			continue;
		}
		distribution[score] = (distribution[score] ?? 0) + 1;
		total += score;
		counted += 1;
	}

	const responseRate = sent > 0 ? counted / sent : null;
	const reportable = counted >= minResponses;

	return {
		sent,
		responses: counted,
		responseRate,
		mean: counted > 0 ? Math.round((total / counted) * 100) / 100 : null,
		distribution,
		reportable,
		note: reportable
			? null
			: counted === 0
				? "No responses yet."
				: `${counted} response${counted === 1 ? "" : "s"} — too few to publish a score (minimum ${minResponses}).`,
	};
}

/**
 * The same summary per region, for the regional comparison on the dashboard.
 *
 * Each region is held to the same minimum independently. A group mean that
 * meets the threshold does not license publishing a regional mean that does
 * not — that is exactly how a thin sample gets laundered into a headline.
 */
export function summariseByRegion(
	records: CsatRecord[],
	sentByRegion: Record<string, number>,
	minResponses: number = MIN_REPORTABLE_RESPONSES,
): Record<string, CsatSummary> {
	const out: Record<string, CsatSummary> = {};
	const regionIds = new Set([
		...Object.keys(sentByRegion),
		...records.map((r) => r.regionId),
	]);
	for (const regionId of regionIds) {
		out[regionId] = summarise(
			records.filter((r) => r.regionId === regionId),
			sentByRegion[regionId] ?? 0,
			minResponses,
		);
	}
	return out;
}
