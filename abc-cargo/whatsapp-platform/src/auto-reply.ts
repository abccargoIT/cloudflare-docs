import type { RegionConfig } from "./regions.ts";

/**
 * Automated first response used when no human agent can pick up a new
 * inbound message: outside business hours, or inside hours with nobody
 * online. Rule based by design so behaviour is predictable and auditable.
 * An AI-assisted draft step can be added in front of the human agent later
 * without changing this contract.
 */

export type AutoReplyReason = "outside-hours" | "no-agents-online";

export interface AutoReplyInput {
	region: RegionConfig;
	reason: AutoReplyReason;
	contactName?: string;
	inboundText?: string;
	trackingUrl?: string;
	/** Override the default tracking-number pattern for ABC Cargo's format. */
	trackingPattern?: RegExp;
}

/**
 * Placeholder pattern: two to four letters followed by up to three groups of
 * digits, which may be separated by a dash or a space. Customers write the
 * same reference as ABC-471-88210, ABC 471 88210 or ABC47188210, and all
 * three have to reach the same shipment.
 *
 * Replace with the exact ABC Cargo AWB / tracking format before go-live; the
 * total digit bounds below are the second half of the guard and should be
 * tightened at the same time.
 */
export const DEFAULT_TRACKING_PATTERN =
	/\b[A-Z]{2,4}(?:[- ]?\d{2,12}){1,3}\b/gi;

/** Total digits a candidate must carry to be treated as a reference. */
export const TRACKING_MIN_DIGITS = 6;
export const TRACKING_MAX_DIGITS = 12;

export function extractTrackingNumbers(
	text: string | undefined,
	pattern: RegExp = DEFAULT_TRACKING_PATTERN,
): string[] {
	if (!text) return [];
	const re = new RegExp(
		pattern.source,
		pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
	);
	const found = new Set<string>();
	for (const match of text.matchAll(re)) {
		const normalised = match[0].replace(/[- ]/g, "").toUpperCase();
		const digits = normalised.replace(/\D/g, "").length;
		// The pattern alone would accept "here 12"; the digit count is what
		// separates a reference from an ordinary word next to a number.
		if (digits < TRACKING_MIN_DIGITS || digits > TRACKING_MAX_DIGITS) continue;
		found.add(normalised);
	}
	return [...found];
}

export function buildAutoReply(input: AutoReplyInput): string {
	const greeting = input.contactName
		? `Hello ${input.contactName.trim()},`
		: "Hello,";
	const tracking = extractTrackingNumbers(
		input.inboundText,
		input.trackingPattern,
	);
	const lines: string[] = [greeting, ""];

	lines.push(
		`Thank you for contacting ABC Cargo (${input.region.label}). This is an automated reply.`,
	);

	if (tracking.length > 0) {
		lines.push(
			"",
			`We have noted your shipment reference${tracking.length > 1 ? "s" : ""}: ${tracking.join(", ")}.`,
		);
		if (input.trackingUrl) {
			lines.push(`You can check the latest status at ${input.trackingUrl}`);
		}
	}

	if (input.reason === "outside-hours") {
		const { days, start, end } = input.region.businessHours;
		lines.push(
			"",
			`Our ${input.region.label} customer service team is currently offline. Working hours are ${start} to ${end} (${input.region.timezone}) on ${describeDays(days)}.`,
			"A team member will reply as soon as we are back online.",
		);
	} else {
		lines.push(
			"",
			"All our agents are currently assisting other customers. Your message has been queued and a team member will reply shortly.",
		);
	}

	lines.push(
		"",
		"Please include your shipment reference and a short description of your request so we can help you faster.",
	);
	return lines.join("\n");
}

const DAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

export function describeDays(days: number[]): string {
	const sorted = [...new Set(days)].sort((a, b) => a - b);
	if (sorted.length === 7) return "all days";
	if (sorted.length === 0) return "no days";
	const names = sorted.map((d) => DAY_NAMES[d] ?? String(d));
	if (names.length === 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
