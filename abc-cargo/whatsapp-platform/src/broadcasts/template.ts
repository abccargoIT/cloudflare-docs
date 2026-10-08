/**
 * Checking the template variables before a campaign is built on them.
 *
 * A malformed components document does not fail once. Meta rejects it for
 * every recipient, so a single wrong field becomes five thousand failed sends
 * and a quality-rating problem on the number. Checking the shape when the
 * campaign is composed turns that into an error message for one person.
 *
 * This validates the *shape* the Cloud API requires. Whether the variables
 * match the approved template — the right number of them, in the right
 * positions — is something only Meta knows, and the way to find out is the
 * test send.
 */

import type {
	TemplateComponent,
	TemplateParameter,
} from "../whatsapp/types.ts";

const COMPONENT_TYPES = ["header", "body", "button"] as const;
const SUB_TYPES = ["quick_reply", "url"] as const;
const PARAMETER_TYPES = [
	"text",
	"currency",
	"date_time",
	"image",
	"document",
	"video",
] as const;

export interface TemplateProblem {
	where: string;
	message: string;
}

export type ParsedComponents =
	| { ok: true; components: TemplateComponent[] | undefined }
	| { ok: false; problems: TemplateProblem[] };

/**
 * Reads and checks a components document.
 *
 * `undefined` and `null` are both valid: a template with no variables needs
 * none. An empty array is treated the same way rather than sent as `[]`.
 */
export function parseTemplateComponents(input: unknown): ParsedComponents {
	if (input === undefined || input === null) {
		return { ok: true, components: undefined };
	}

	let raw: unknown = input;
	if (typeof input === "string") {
		try {
			raw = JSON.parse(input);
		} catch {
			return {
				ok: false,
				problems: [{ where: "components", message: "is not valid JSON" }],
			};
		}
	}

	if (!Array.isArray(raw)) {
		return {
			ok: false,
			problems: [
				{
					where: "components",
					message: "must be an array, as the Cloud API takes",
				},
			],
		};
	}
	if (raw.length === 0) return { ok: true, components: undefined };

	const problems: TemplateProblem[] = [];
	const components: TemplateComponent[] = [];

	for (const [index, item] of raw.entries()) {
		const where = `components[${index}]`;
		if (typeof item !== "object" || item === null) {
			problems.push({ where, message: "is not an object" });
			continue;
		}
		const obj = item as Record<string, unknown>;

		const type = obj["type"];
		if (
			typeof type !== "string" ||
			!(COMPONENT_TYPES as readonly string[]).includes(type)
		) {
			problems.push({
				where,
				message: `type must be ${COMPONENT_TYPES.join(", ")}`,
			});
			continue;
		}

		const subType = obj["sub_type"];
		if (
			subType !== undefined &&
			(typeof subType !== "string" ||
				!(SUB_TYPES as readonly string[]).includes(subType))
		) {
			problems.push({
				where,
				message: `sub_type must be ${SUB_TYPES.join(" or ")} when present`,
			});
			continue;
		}

		// A button component without its index is the most common mistake here,
		// and Meta's rejection for it is not self-explanatory.
		const rawIndex = obj["index"];
		if (type === "button" && typeof rawIndex !== "string") {
			problems.push({
				where,
				message: "a button component needs an index, as a string",
			});
			continue;
		}

		const rawParameters = obj["parameters"];
		if (!Array.isArray(rawParameters)) {
			problems.push({ where, message: "needs a parameters array" });
			continue;
		}

		const parameters: TemplateParameter[] = [];
		let parametersOk = true;
		for (const [p, rawParameter] of rawParameters.entries()) {
			const pWhere = `${where}.parameters[${p}]`;
			if (typeof rawParameter !== "object" || rawParameter === null) {
				problems.push({ where: pWhere, message: "is not an object" });
				parametersOk = false;
				continue;
			}
			const parameter = rawParameter as Record<string, unknown>;
			const pType = parameter["type"];
			if (
				typeof pType !== "string" ||
				!(PARAMETER_TYPES as readonly string[]).includes(pType)
			) {
				problems.push({
					where: pWhere,
					message: `type must be one of ${PARAMETER_TYPES.join(", ")}`,
				});
				parametersOk = false;
				continue;
			}
			if (pType === "text" && typeof parameter["text"] !== "string") {
				problems.push({
					where: pWhere,
					message: "a text parameter needs text",
				});
				parametersOk = false;
				continue;
			}
			parameters.push(parameter as unknown as TemplateParameter);
		}
		if (!parametersOk) continue;

		components.push({
			type: type as TemplateComponent["type"],
			...(subType
				? { sub_type: subType as TemplateComponent["sub_type"] }
				: {}),
			...(typeof rawIndex === "string" ? { index: rawIndex } : {}),
			parameters,
		});
	}

	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, components };
}

/**
 * A template name as Meta accepts it: lower case, digits and underscores.
 *
 * Checked because a name with a capital or a space is accepted here and
 * rejected at send time, which turns a typo into a failed campaign.
 */
export function looksLikeTemplateName(value: string): boolean {
	return /^[a-z0-9_]{1,512}$/.test(value.trim());
}

/** Language codes are "en", "en_US", "ar" — not "English". */
export function looksLikeLanguageCode(value: string): boolean {
	return /^[a-z]{2,3}(_[A-Z]{2})?$/.test(value.trim());
}
