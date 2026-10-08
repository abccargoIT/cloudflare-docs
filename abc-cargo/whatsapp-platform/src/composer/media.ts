/**
 * What an agent is allowed to attach, and what it will look like when it
 * arrives.
 *
 * Checked here, before anything is uploaded. Meta is the authority on what it
 * accepts, and it will reject a bad attachment — but it rejects it *after* the
 * upload, which on a 60 MB video means a minute of waiting for an error
 * message that reads like a server fault. Refusing locally is instant and says
 * what is wrong.
 *
 * **The limits below are from Meta's published documentation and Meta changes
 * them.** They are a courtesy to the agent, not a specification: the real
 * answer always comes from the Cloud API. They should be confirmed against the
 * current documentation before go-live and whenever an attachment is rejected
 * for a reason this file did not predict.
 */

export const MEDIA_KINDS = [
	"image",
	"document",
	"audio",
	"video",
	"sticker",
] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export function isMediaKind(value: string): value is MediaKind {
	return (MEDIA_KINDS as readonly string[]).includes(value);
}

/** Megabytes, as Meta documents them. */
const MB = 1024 * 1024;

interface KindRules {
	maxBytes: number;
	/** Exact media types, lower-cased, without parameters. */
	types: string[];
}

const RULES: Record<MediaKind, KindRules> = {
	image: { maxBytes: 5 * MB, types: ["image/jpeg", "image/png"] },
	// Documents are deliberately open: an agent sending a customs declaration
	// should not be stopped because nobody listed that file type.
	document: { maxBytes: 100 * MB, types: [] },
	audio: {
		maxBytes: 16 * MB,
		types: [
			"audio/aac",
			"audio/mp4",
			"audio/mpeg",
			"audio/amr",
			"audio/ogg",
			"audio/opus",
		],
	},
	video: { maxBytes: 16 * MB, types: ["video/mp4", "video/3gp"] },
	sticker: { maxBytes: 100 * 1024, types: ["image/webp"] },
};

export type MediaRefusal =
	| "unknown_kind"
	| "empty_file"
	| "too_large"
	| "wrong_type"
	| "missing_filename";

export type MediaCheck =
	| {
			ok: true;
			kind: MediaKind;
			/** The type as it should be sent, without parameters. */
			mimeType: string;
			filename?: string;
			/**
			 * True when this will arrive as a push-to-talk voice note rather
			 * than as an audio file. See `rendersAsVoiceNote`.
			 */
			voiceNote: boolean;
			/** Worth showing the agent; not a refusal. */
			warnings: string[];
	  }
	| { ok: false; reason: MediaRefusal; message: string };

/**
 * Whether WhatsApp will show this as a voice note.
 *
 * Only Ogg with the Opus codec renders as push-to-talk. Every other audio
 * type arrives as a file attachment with a play button, which is a different
 * thing to receive. An agent who records a voice note and sees it arrive as
 * "audio.m4a" concludes the feature is broken, so the composer says which it
 * will be rather than leaving them to find out.
 */
export function rendersAsVoiceNote(mimeType: string): boolean {
	const normalised = mimeType.toLowerCase();
	if (!normalised.startsWith("audio/ogg")) return false;
	// A bare "audio/ogg" with no codec parameter is accepted by Meta as a voice
	// note; "audio/ogg; codecs=vorbis" is not.
	const codecs = /codecs\s*=\s*"?([^";]+)"?/.exec(normalised)?.[1];
	return codecs === undefined || codecs.trim() === "opus";
}

/** The media type without its parameters, lower-cased. */
export function baseMimeType(value: string): string {
	return (value.split(";")[0] ?? "").trim().toLowerCase();
}

export function checkMedia(input: {
	kind: string;
	mimeType: string;
	sizeBytes: number;
	filename?: string;
}): MediaCheck {
	if (!isMediaKind(input.kind)) {
		return {
			ok: false,
			reason: "unknown_kind",
			message: `attachments are ${MEDIA_KINDS.join(", ")}`,
		};
	}
	const kind = input.kind;
	const rules = RULES[kind];
	const mimeType = baseMimeType(input.mimeType);
	const warnings: string[] = [];

	if (input.sizeBytes <= 0) {
		return { ok: false, reason: "empty_file", message: "the file is empty" };
	}
	if (input.sizeBytes > rules.maxBytes) {
		return {
			ok: false,
			reason: "too_large",
			message: `${article(kind)} may be up to ${describeBytes(rules.maxBytes)}; this is ${describeBytes(input.sizeBytes)}`,
		};
	}
	if (rules.types.length > 0 && !rules.types.includes(mimeType)) {
		return {
			ok: false,
			reason: "wrong_type",
			message: `${article(kind)} must be ${rules.types.join(", ")}; this is ${mimeType || "of no stated type"}`,
		};
	}

	// A document arrives showing its filename. Without one the customer sees
	// an unnamed attachment, which for a commercial invoice is unhelpful and
	// looks like a mistake on our part.
	let filename: string | undefined;
	if (kind === "document") {
		filename = safeFilename(input.filename);
		if (!filename) {
			return {
				ok: false,
				reason: "missing_filename",
				message:
					"a document needs a filename; it is what the customer sees in the chat",
			};
		}
		if (filename !== input.filename?.trim()) {
			warnings.push(`the filename was adjusted to "${filename}"`);
		}
	}

	const voiceNote = kind === "audio" && rendersAsVoiceNote(input.mimeType);
	if (kind === "audio" && !voiceNote) {
		warnings.push(
			"this will arrive as an audio file, not a voice note; only Ogg Opus shows as push-to-talk",
		);
	}

	return { ok: true, kind, mimeType, filename, voiceNote, warnings };
}

/**
 * A filename safe to show a customer and to put in a JSON payload.
 *
 * Path separators are removed rather than rejected: an agent attaching
 * `C:\\Users\\mariam\\invoice.pdf` meant `invoice.pdf`, and refusing them is
 * unhelpful. Control characters go because they have no place in a name the
 * customer reads.
 */
export function safeFilename(value: string | undefined): string | undefined {
	if (!value) return undefined;
	// Control characters are dropped by code point rather than by a regex, so
	// the intent is readable and the linter does not have to be argued with.
	const withoutControls = [...value]
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code >= 0x20 && code !== 0x7f;
		})
		.join("");
	const cleaned = withoutControls
		.replace(/[\\/]+/g, "/")
		.split("/")
		.filter((part) => part !== "" && part !== "." && part !== "..")
		.pop();
	if (!cleaned) return undefined;
	const trimmed = cleaned.trim().slice(0, 240);
	return trimmed.length > 0 ? trimmed : undefined;
}

/** "an image", "a document" — the message is read by an agent. */
function article(kind: MediaKind): string {
	return /^[aeiou]/.test(kind) ? `an ${kind}` : `a ${kind}`;
}

function describeBytes(bytes: number): string {
	if (bytes >= MB) {
		const mb = bytes / MB;
		return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
	}
	return `${Math.ceil(bytes / 1024)} KB`;
}

/* -------------------------------------------------------------- location */

export type LocationRefusal =
	"out_of_range" | "not_a_number" | "null_island" | "name_without_address";

export type LocationCheck =
	| {
			ok: true;
			latitude: number;
			longitude: number;
			name?: string;
			address?: string;
	  }
	| { ok: false; reason: LocationRefusal; message: string };

export function checkLocation(input: {
	latitude: unknown;
	longitude: unknown;
	name?: string;
	address?: string;
}): LocationCheck {
	const latitude = Number(input.latitude);
	const longitude = Number(input.longitude);

	if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
		return {
			ok: false,
			reason: "not_a_number",
			message: "a location needs a numeric latitude and longitude",
		};
	}
	if (latitude < -90 || latitude > 90) {
		return {
			ok: false,
			reason: "out_of_range",
			message: "latitude runs from -90 to 90",
		};
	}
	if (longitude < -180 || longitude > 180) {
		return {
			ok: false,
			reason: "out_of_range",
			message: "longitude runs from -180 to 180",
		};
	}
	// Exactly zero on both axes is in the Gulf of Guinea and is almost always
	// an uninitialised value rather than a place anybody meant to send.
	if (latitude === 0 && longitude === 0) {
		return {
			ok: false,
			reason: "null_island",
			message:
				"0, 0 is in the Atlantic; this is usually an empty coordinate rather than a place",
		};
	}

	const name = input.name?.trim() || undefined;
	const address = input.address?.trim() || undefined;
	// WhatsApp shows the name as the heading and the address beneath it. A name
	// with no address renders as a pin with a label and no way to find it,
	// which for a warehouse is the one thing the customer needs.
	if (name && !address) {
		return {
			ok: false,
			reason: "name_without_address",
			message:
				"a named location needs an address too; the name alone gives the customer nothing to navigate to",
		};
	}

	return { ok: true, latitude, longitude, name, address };
}
