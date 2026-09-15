/**
 * Human-readable references. Agents read these out on calls and customers
 * quote them back over WhatsApp, so they must be short, unambiguous and
 * impossible to confuse when spoken or handwritten.
 */

/**
 * Deliberately excludes characters that are misread aloud or on paper:
 * I/1, O/0, S/5, Z/2, B/8.
 */
const ALPHABET = "ACDEFGHJKLMNPQRTUVWXY34679";

export type RefKind = "lead" | "quotation" | "ticket" | "booking";

const PREFIX: Record<RefKind, string> = {
	lead: "L",
	quotation: "Q",
	ticket: "T",
	booking: "ABC",
};

/**
 * Region codes appear in the booking reference so a customer service agent
 * can tell at a glance which office owns the shipment.
 */
export function regionCode(regionId: string): string {
	const cleaned = regionId.replace(/[^A-Za-z]/g, "").toUpperCase();
	return (cleaned.slice(0, 3) || "GEN").padEnd(3, "X");
}

/**
 * Sequence-based reference. The caller supplies the next number for the
 * kind, which keeps references dense and predictable rather than random.
 */
export function buildRef(
	kind: RefKind,
	sequence: number,
	regionId?: string,
): string {
	if (!Number.isInteger(sequence) || sequence < 1) {
		throw new Error("sequence must be a positive integer");
	}
	if (kind === "booking") {
		if (!regionId) throw new Error("booking references need a region");
		return `${PREFIX.booking}-${regionCode(regionId)}-${String(sequence).padStart(6, "0")}`;
	}
	return `${PREFIX[kind]}-${String(sequence).padStart(5, "0")}`;
}

/**
 * Short code for anything that has no sequence to draw on — an idempotency
 * key, or a reference minted before the row is written.
 */
export function shortCode(
	length = 6,
	random: () => number = Math.random,
): string {
	if (length < 1) throw new Error("length must be at least 1");
	let out = "";
	for (let i = 0; i < length; i++) {
		const index = Math.floor(random() * ALPHABET.length) % ALPHABET.length;
		out += ALPHABET[index];
	}
	return out;
}

const REF_PATTERNS: Record<RefKind, RegExp> = {
	lead: /^L-\d{5,}$/,
	quotation: /^Q-\d{5,}$/,
	ticket: /^T-\d{5,}$/,
	booking: /^ABC-[A-Z]{3}-\d{6,}$/,
};

export function isRef(kind: RefKind, value: string): boolean {
	return REF_PATTERNS[kind].test(value.trim().toUpperCase());
}

/** Identifies which kind of record a reference belongs to, if any. */
export function classifyRef(value: string): RefKind | null {
	const v = value.trim().toUpperCase();
	for (const kind of Object.keys(REF_PATTERNS) as RefKind[]) {
		if (REF_PATTERNS[kind].test(v)) return kind;
	}
	return null;
}
