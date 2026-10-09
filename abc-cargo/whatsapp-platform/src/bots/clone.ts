/**
 * Copying a published flow to another region.
 *
 * The screen designs offer "clone flow to another region" as a single button,
 * and building it turned up the reason it cannot be one: a flow is written
 * against a region, and several things inside it are wrong the moment it moves.
 *
 * The one that matters is the **handover queue**. A UAE flow routes its
 * escalations to the UAE desk. Cloned to KSA without touching that, a Saudi
 * customer who asks for a person is put in the Dubai queue, where nobody is
 * looking for them and where the service target belongs to a different team.
 * That is a silent mis-route, which is the worst kind, so queues that name the
 * source region are remapped and queues that name something else are refused
 * rather than guessed at.
 *
 * The rest of the file is about what **cannot** be fixed automatically. A step
 * that says "our office is open 08:00 to 18:00" or quotes a price in AED or
 * prints `+971800916` is wrong in Riyadh, and no amount of string replacement
 * makes it right — the hours differ, the currency differs, and the number is
 * the other region's. So those are reported per step and the clone arrives as
 * a **draft**. Publishing it is a separate, deliberate act.
 *
 * Nothing here publishes anything. A clone that went straight to `published`
 * would put an unreviewed flow in front of customers on a live number, which
 * is precisely the accident this module exists to prevent.
 */

import type { RegionConfig } from "../regions.ts";
import type { BotFlow, BotStep } from "./types.ts";
import { validateFlow, type FlowValidation } from "./validate.ts";

export interface CloneWarning {
	stepId: string | null;
	code:
		| "queue_remapped"
		| "queue_unrecognised"
		| "mentions_source_number"
		| "mentions_currency"
		| "mentions_hours"
		| "mentions_region_name"
		| "language_differs";
	message: string;
}

export interface CloneResult {
	flow: BotFlow;
	warnings: CloneWarning[];
	/** The clone run through the ordinary publish checks. */
	validation: FlowValidation;
}

export type CloneOutcome =
	({ ok: true } & CloneResult) | { ok: false; error: string };

/** Currency codes the three operations quote in. */
const CURRENCIES = ["AED", "SAR", "GBP", "USD", "OMR"];

/**
 * Clones `flow` into `toRegion`.
 *
 * Returns the new flow as a draft, every warning worth a human's attention,
 * and the validation result, so a caller can refuse to save a clone that does
 * not even pass the publish checks.
 */
export function cloneFlowToRegion(
	flow: BotFlow,
	fromRegion: RegionConfig,
	toRegion: RegionConfig,
	options: { newId?: string; name?: string } = {},
): CloneOutcome {
	if (flow.regionId !== fromRegion.id) {
		return {
			ok: false,
			error: `flow ${flow.id} belongs to region ${flow.regionId}, not ${fromRegion.id}`,
		};
	}
	if (fromRegion.id === toRegion.id) {
		return { ok: false, error: "a flow cannot be cloned onto its own region" };
	}
	if (flow.steps.length === 0) {
		return { ok: false, error: "the flow has no steps to clone" };
	}

	const warnings: CloneWarning[] = [];

	const steps = flow.steps.map((step) =>
		cloneStep(step, fromRegion, toRegion, warnings),
	);

	// The language is a property of the number, not of the flow's words. If
	// the two regions differ, the text still needs translating by a person.
	if (fromRegion.language !== toRegion.language) {
		warnings.push({
			stepId: null,
			code: "language_differs",
			message: `${fromRegion.label} is configured for ${fromRegion.language} and ${toRegion.label} for ${toRegion.language}; the text is not translated by cloning`,
		});
	}

	const clone: BotFlow = {
		id: options.newId ?? `${flow.id}-${toRegion.id}`,
		regionId: toRegion.id,
		name: options.name ?? `${flow.name} (${toRegion.label})`,
		// A clone starts at version 1 in its new region: it shares no history
		// with the original, and carrying the version over would make two
		// unrelated flows look like the same one at the same revision.
		version: 1,
		// Never published. See the file comment.
		status: "draft",
		entryStepId: flow.entryStepId,
		steps,
	};

	return { ok: true, flow: clone, warnings, validation: validateFlow(clone) };
}

function cloneStep(
	step: BotStep,
	fromRegion: RegionConfig,
	toRegion: RegionConfig,
	warnings: CloneWarning[],
): BotStep {
	const copy: BotStep = structuredClone(step);

	if (copy.kind === "handover" && copy.queue) {
		copy.queue = remapQueue(
			copy.queue,
			fromRegion,
			toRegion,
			copy.id,
			warnings,
		);
	}

	for (const text of textsOf(copy)) {
		inspectText(text, copy.id, fromRegion, toRegion, warnings);
	}

	return copy;
}

/**
 * Moves a queue name to the destination region, or refuses to.
 *
 * The convention is `<regionId>-<desk>`, which is what `escalation.ts`
 * generates and what the seeded teams use. Anything else is a name somebody
 * chose, and a guess at its counterpart would be a mis-route — so it is
 * carried over unchanged and flagged loudly.
 */
function remapQueue(
	queue: string,
	fromRegion: RegionConfig,
	toRegion: RegionConfig,
	stepId: string,
	warnings: CloneWarning[],
): string {
	// A queue that is exactly the region id is the clearest case of all, and
	// the first version of this function missed it: it only matched the
	// `<regionId>-<desk>` form, so the starter flow's plain `uae` queue fell
	// through to "unrecognised" and would have been carried into KSA.
	if (queue === fromRegion.id) {
		warnings.push({
			stepId,
			code: "queue_remapped",
			message: `queue "${queue}" became "${toRegion.id}"; check that desk exists in ${toRegion.label}`,
		});
		return toRegion.id;
	}

	const prefix = `${fromRegion.id}-`;
	if (queue.startsWith(prefix)) {
		const remapped = `${toRegion.id}-${queue.slice(prefix.length)}`;
		warnings.push({
			stepId,
			code: "queue_remapped",
			message: `queue "${queue}" became "${remapped}"; check that desk exists in ${toRegion.label}`,
		});
		return remapped;
	}

	warnings.push({
		stepId,
		code: "queue_unrecognised",
		message: `queue "${queue}" does not name a region, so it was left as it is — it will route ${toRegion.label} customers to wherever that queue lives`,
	});
	return queue;
}

/** Every customer-visible string on a step. */
function textsOf(step: BotStep): string[] {
	const out: string[] = [];
	if ("text" in step && typeof step.text === "string") out.push(step.text);
	if ("retryText" in step && typeof step.retryText === "string") {
		out.push(step.retryText);
	}
	if (step.kind === "menu") {
		for (const option of step.options) out.push(option.label);
	}
	return out;
}

/**
 * Looks for things in a string that stop being true in another region.
 *
 * Reports rather than rewrites. "Open 08:00 to 18:00" cannot be corrected by
 * substitution — the destination's hours are different and the sentence may
 * need restructuring — and silently editing a customer-facing message is
 * worse than asking somebody to read it.
 */
function inspectText(
	text: string,
	stepId: string,
	fromRegion: RegionConfig,
	toRegion: RegionConfig,
	warnings: CloneWarning[],
): void {
	const seen = new Set(
		warnings.filter((w) => w.stepId === stepId).map((w) => w.code),
	);
	const add = (code: CloneWarning["code"], message: string) => {
		if (seen.has(code)) return;
		seen.add(code);
		warnings.push({ stepId, code, message });
	};

	// The source number, with or without spaces and punctuation.
	const digits = fromRegion.displayNumber.replace(/\D/g, "");
	if (digits && text.replace(/\D/g, "").includes(digits)) {
		add(
			"mentions_source_number",
			`mentions ${fromRegion.displayNumber}, which is ${fromRegion.label}'s number`,
		);
	}

	for (const code of CURRENCIES) {
		if (new RegExp(`\\b${code}\\b`).test(text)) {
			add("mentions_currency", `quotes a price in ${code}`);
			break;
		}
	}

	// A time of day, or the source region's own opening hours in words.
	if (
		/\b([01]?\d|2[0-3]):[0-5]\d\b/.test(text) ||
		/\b(?:am|pm)\b/i.test(text)
	) {
		add(
			"mentions_hours",
			`mentions a time of day; ${toRegion.label} is open ${toRegion.businessHours.start}-${toRegion.businessHours.end} on a different week`,
		);
	}

	// The source region's own name or city.
	const names = [fromRegion.label, fromRegion.timezone.split("/").pop() ?? ""]
		.filter(Boolean)
		.map((n) => n.replace(/_/g, " "));
	for (const name of names) {
		if (new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(text)) {
			add("mentions_region_name", `mentions "${name}"`);
			break;
		}
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a clone is safe to save without a human reading it first.
 *
 * Only true when the publish checks pass and nothing was flagged. In practice
 * it is almost never true, which is the honest answer: a flow written for one
 * country rarely transfers untouched.
 */
export function cloneNeedsReview(result: CloneResult): boolean {
	return !result.validation.ok || result.warnings.length > 0;
}
