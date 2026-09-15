/**
 * Intent recognition for inbound customer messages.
 *
 * Rule based on purpose. The bot's behaviour has to be explainable to a
 * supervisor and reproducible in a test, and a misrouted claim costs more
 * than a missed classification. A model-assisted pass can be added in front
 * of this without changing the contract: it returns the same Intent, and
 * this remains the fallback when the model is unavailable or unsure.
 *
 * Arabic keywords are included because the KSA and UAE numbers receive a
 * large share of Arabic messages.
 */

import {
	DEFAULT_TRACKING_PATTERN,
	extractTrackingNumbers,
} from "../auto-reply.ts";

export const INTENTS = [
	"track",
	"rate",
	"claim",
	"booking_change",
	"billing",
	"documentation",
	"agent",
	"greeting",
	"unknown",
] as const;
export type Intent = (typeof INTENTS)[number];

export interface IntentResult {
	intent: Intent;
	/** 0 to 1. A reference in the text lifts confidence for tracking. */
	confidence: number;
	/** Shipment references found in the message, normalised and uppercased. */
	references: string[];
	/** The keyword that decided the classification, for the audit trail. */
	matched: string | null;
}

interface Rule {
	intent: Intent;
	/** Ordered by cost of getting it wrong, highest first. */
	weight: number;
	keywords: string[];
}

/**
 * Claims sit at the top: routing a damage claim to a sales queue is the
 * most expensive mistake this classifier can make.
 */
const RULES: Rule[] = [
	{
		intent: "claim",
		weight: 100,
		keywords: [
			"claim",
			"damaged",
			"damage",
			"broken",
			"missing",
			"lost item",
			"stolen",
			"complaint",
			"شكوى",
			"تالف",
			"مفقود",
			"مكسور",
		],
	},
	{
		intent: "billing",
		weight: 80,
		keywords: [
			"invoice",
			"bill",
			"overcharged",
			"refund",
			"payment",
			"duty",
			"customs charge",
			"فاتورة",
			"دفع",
			"رسوم",
		],
	},
	{
		intent: "booking_change",
		weight: 70,
		keywords: [
			"change the address",
			"change address",
			"reschedule",
			"cancel my booking",
			"cancel booking",
			"add a box",
			"add one more",
			"amend",
			"تعديل",
			"إلغاء",
		],
	},
	{
		intent: "documentation",
		weight: 60,
		keywords: [
			"invoice copy",
			"commercial invoice",
			"packing list",
			"certificate",
			"paperwork",
			"documents",
			"awb copy",
			"مستندات",
			"شهادة",
		],
	},
	{
		intent: "rate",
		weight: 50,
		keywords: [
			"rate",
			"quote",
			"quotation",
			"price",
			"how much",
			"cost to send",
			"charges to",
			"سعر",
			"عرض سعر",
			"كم",
			"تكلفة",
		],
	},
	{
		intent: "track",
		weight: 40,
		keywords: [
			"where is my",
			"track",
			"tracking",
			"status",
			"delivered",
			"shipment update",
			"any update",
			"تتبع",
			"اين شحنتي",
			"أين شحنتي",
			"حالة",
		],
	},
	{
		intent: "agent",
		weight: 30,
		keywords: [
			"talk to an agent",
			"speak to someone",
			"speak to a person",
			"human",
			"customer service",
			"موظف",
			"خدمة العملاء",
		],
	},
	{
		intent: "greeting",
		weight: 10,
		keywords: [
			"hi",
			"hello",
			"hey",
			"good morning",
			"good evening",
			"مرحبا",
			"السلام عليكم",
		],
	},
];

/** Greetings only count when they are effectively the whole message. */
const GREETING_MAX_WORDS = 3;

export function classifyIntent(
	text: string | undefined,
	trackingPattern: RegExp = DEFAULT_TRACKING_PATTERN,
): IntentResult {
	const raw = (text ?? "").trim();
	const references = extractReferences(raw, trackingPattern);

	if (raw === "") {
		return { intent: "unknown", confidence: 0, references, matched: null };
	}

	const haystack = raw.toLowerCase();
	const words = haystack.split(/\s+/).filter(Boolean).length;

	let best: { rule: Rule; keyword: string } | null = null;
	for (const rule of RULES) {
		if (rule.intent === "greeting" && words > GREETING_MAX_WORDS) continue;
		for (const keyword of rule.keywords) {
			if (!containsKeyword(haystack, keyword)) continue;
			if (!best || rule.weight > best.rule.weight) {
				best = { rule, keyword };
			}
			break;
		}
	}

	// A bare reference with no other signal is a tracking request.
	if (!best && references.length > 0) {
		return { intent: "track", confidence: 0.75, references, matched: null };
	}

	if (!best) {
		return { intent: "unknown", confidence: 0, references, matched: null };
	}

	let confidence = best.rule.weight / 100;
	if (best.rule.intent === "track" && references.length > 0) {
		confidence = Math.min(1, confidence + 0.4);
	}
	return {
		intent: best.rule.intent,
		confidence: Number(confidence.toFixed(2)),
		references,
		matched: best.keyword,
	};
}

/**
 * Word-boundary match for Latin keywords so "hi" does not fire inside
 * "shipping". Arabic and multi-word phrases fall back to a substring test,
 * which is correct for a script without the same boundary semantics.
 */
function containsKeyword(haystack: string, keyword: string): boolean {
	if (!/^[a-z0-9 ']+$/.test(keyword)) return haystack.includes(keyword);
	const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * Shipment references in a message. Delegates to the single extractor in
 * auto-reply so the bot and the classifier can never disagree about what
 * counts as a reference.
 */
export function extractReferences(
	text: string,
	pattern: RegExp = DEFAULT_TRACKING_PATTERN,
): string[] {
	return extractTrackingNumbers(text, pattern);
}

/**
 * What the platform should create when the bot cannot resolve the intent
 * itself. Returning null means "keep the conversation, create nothing".
 */
export type IntentOutcome = "lead" | "ticket" | null;

export function outcomeFor(intent: Intent): IntentOutcome {
	switch (intent) {
		case "rate":
			return "lead";
		case "claim":
		case "billing":
		case "documentation":
		case "booking_change":
			return "ticket";
		case "track":
		case "agent":
		case "greeting":
		case "unknown":
			return null;
	}
}

/** Ticket type for an intent that opens a ticket. */
export function ticketTypeFor(
	intent: Intent,
): "claim" | "billing" | "documentation" | "delivery" | "general" {
	switch (intent) {
		case "claim":
			return "claim";
		case "billing":
			return "billing";
		case "documentation":
			return "documentation";
		case "booking_change":
			return "delivery";
		default:
			return "general";
	}
}
