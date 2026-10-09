/**
 * A starter flow, so there is something to run the preview against and
 * something to show Management before the real flows arrive.
 *
 * **This is not any of ABC Cargo's three live bots.** Those are the flows
 * currently running in Freshchat on the UAE, KSA and UK numbers, and they have
 * not been exported yet. Nothing here should be published to a live number as a
 * replacement for one of them: the wording, the branches and the escalation
 * rules of the live flows are not known to this file, and a customer meeting a
 * different bot on the same number is a change they did not agree to.
 *
 * What it is for: exercising the runtime, the validator and the preview on a
 * flow of realistic shape, and giving whoever rebuilds the real flows a working
 * example of each step kind.
 */

import type { BotStep } from "./types.ts";

export interface StarterFlow {
	name: string;
	entryStepId: string;
	steps: BotStep[];
}

export function buildStarterFlow(region: {
	id: string;
	label: string;
}): StarterFlow {
	const steps: BotStep[] = [
		// The first message is classified rather than answered with a menu. A
		// customer who opens with "where is ABC-UAE-088210" has already said
		// what they want, and making them pick it from a list is the thing
		// people dislike most about bots.
		{
			id: "triage",
			kind: "classify",
			branches: {
				track: "find_shipment",
				rate: "quote_start",
				claim: "claim_start",
				billing: "billing_ticket",
				documentation: "documents_ticket",
				booking_change: "change_ticket",
				agent: "to_agent",
				greeting: "main_menu",
			},
			otherwise: "main_menu",
		},

		{
			id: "main_menu",
			kind: "menu",
			text: `Hello {{contact.name}} — thank you for contacting ABC Cargo ${region.label}. How can we help?`,
			options: [
				{
					label: "Track a shipment",
					keywords: ["track", "tracking", "تتبع"],
					next: "find_shipment",
				},
				{
					label: "Get a quotation",
					keywords: ["quote", "quotation", "rate", "سعر"],
					next: "quote_start",
				},
				{
					label: "Report damage or a missing item",
					keywords: ["damage", "claim", "شكوى"],
					next: "claim_start",
				},
				{
					label: "Invoice or payment",
					keywords: ["invoice", "payment", "فاتورة"],
					next: "billing_ticket",
				},
				{
					label: "Documents",
					keywords: ["documents", "paperwork", "مستندات"],
					next: "documents_ticket",
				},
				{
					label: "Speak to our team",
					keywords: ["agent", "team", "person", "موظف"],
					next: "to_agent",
				},
			],
		},

		/* --------------------------------------------------------- tracking */

		// Takes the reference out of the message the customer already sent,
		// before asking for one they have already given.
		{
			id: "find_shipment",
			kind: "lookup",
			found: "shipment_status",
			notFound: "ask_reference",
		},

		{
			id: "ask_reference",
			kind: "ask",
			text: "Could you send the shipment reference? It looks like ABC-UAE-088210.",
			slot: "reference",
			expect: "reference",
			next: "find_by_reference",
		},

		{
			id: "find_by_reference",
			kind: "lookup",
			slot: "reference",
			found: "shipment_status",
			notFound: "reference_unknown",
		},

		{
			id: "shipment_status",
			kind: "message",
			text: "Shipment {{booking.ref}} — latest update: {{booking.milestone}}.",
			next: "anything_else",
		},

		// A reference we hold no record of is not a dead end. It is also what an
		// unreachable shipment system looks like, and in both cases a person is
		// the right answer.
		{
			id: "reference_unknown",
			kind: "message",
			text: "I cannot find {{reference}} on our system. Let me pass you to a member of our team who can check.",
			next: "to_agent",
		},

		/* ------------------------------------------------------ quotations */

		{
			id: "quote_start",
			kind: "ask",
			text: "I can arrange a quotation. Where is the shipment going from, and where to?",
			slot: "route",
			next: "quote_goods",
		},
		{
			id: "quote_goods",
			kind: "ask",
			text: "Thank you. What are you sending, and roughly what weight?",
			slot: "goods",
			next: "quote_lead",
		},
		{ id: "quote_lead", kind: "create", create: "lead", next: "to_agent" },

		/* ----------------------------------------------------------- claims */

		// Straight to a person, with the account taken first so they do not have
		// to tell it twice. A damage claim is the last thing to leave in a bot.
		{
			id: "claim_start",
			kind: "ask",
			text: "I am sorry to hear that. Please tell me what has happened, and include the shipment reference if you have it.",
			slot: "what_happened",
			next: "claim_ticket",
		},
		{
			id: "claim_ticket",
			kind: "create",
			create: "ticket",
			ticketType: "claim",
			next: "to_agent",
		},

		/* --------------------------------------------------- other requests */

		{
			id: "billing_ticket",
			kind: "create",
			create: "ticket",
			ticketType: "billing",
			next: "to_agent",
		},
		{
			id: "documents_ticket",
			kind: "create",
			create: "ticket",
			ticketType: "documentation",
			next: "to_agent",
		},
		{
			id: "change_ticket",
			kind: "create",
			create: "ticket",
			ticketType: "delivery",
			next: "to_agent",
		},

		/* ------------------------------------------------------------- close */

		{
			id: "anything_else",
			kind: "menu",
			text: "Is there anything else I can help with?",
			options: [
				{ label: "Yes", keywords: ["yes", "نعم"], next: "main_menu" },
				{ label: "No, thank you", keywords: ["no", "لا"], next: "goodbye" },
			],
		},
		{
			id: "goodbye",
			kind: "end",
			text: "Thank you for contacting ABC Cargo. We are here whenever you need us.",
		},
		{
			id: "to_agent",
			kind: "handover",
			text: "I am passing you to a member of our team now. They will reply here.",
			queue: region.id,
		},
	];

	return {
		name: `ABC Cargo ${region.label} — starter flow (not the live Freshchat flow)`,
		entryStepId: "triage",
		steps,
	};
}
