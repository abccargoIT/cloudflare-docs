/**
 * Microsoft Teams telephony, read through Microsoft Graph.
 *
 * A Teams call record is published after the call ends, so this module can put
 * a call on the customer's timeline but cannot announce one while the phone is
 * ringing. That limit is Microsoft's, not ours, and the design note explains
 * what a screen pop would instead require.
 *
 * Everything here is pure: parsing, matching and mapping take their inputs as
 * arguments and return values. The network lives in `client.ts`, so the rules
 * that decide which customer a call belongs to are testable without a tenant.
 */

/* ------------------------------------------------------------ notifications */

/** One entry in a Graph change notification batch. */
export interface GraphNotification {
	subscriptionId: string;
	changeType: string;
	resource: string;
	clientState?: string;
	resourceData?: { id?: string; "@odata.id"?: string } | null;
}

export interface GraphNotificationBatch {
	value: GraphNotification[];
}

export class NotificationRejected extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotificationRejected";
	}
}

/**
 * Graph proves it owns a new subscription by POSTing to the endpoint with a
 * `validationToken` query parameter, which must be echoed back as plain text
 * within ten seconds. Returns the token when this is such a request.
 */
export function validationTokenFrom(url: URL): string | null {
	return url.searchParams.get("validationToken");
}

/**
 * Parses a notification batch and rejects anything whose `clientState` does
 * not match the secret given to Graph when the subscription was created.
 *
 * The endpoint is public — it has to be, for Graph to reach it — so this is
 * the only thing standing between a stranger's POST and a write to a
 * customer's timeline. Notifications are compared individually because a batch
 * may legitimately carry more than one subscription.
 */
export function parseNotificationBatch(
	body: unknown,
	expectedClientState: string,
): GraphNotification[] {
	if (!expectedClientState) {
		throw new NotificationRejected("no client state configured");
	}
	if (typeof body !== "object" || body === null) {
		throw new NotificationRejected("body is not an object");
	}
	const value = (body as GraphNotificationBatch).value;
	if (!Array.isArray(value)) {
		throw new NotificationRejected("body has no value array");
	}
	for (const notification of value) {
		if (
			typeof notification?.clientState !== "string" ||
			!timingSafeEqual(notification.clientState, expectedClientState)
		) {
			throw new NotificationRejected("client state mismatch");
		}
	}
	return value;
}

/** Constant-time string comparison, so a mismatch leaks no position. */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/* -------------------------------------------------------------- call records */

export interface GraphIdentity {
	user?: { id?: string; displayName?: string; userPrincipalName?: string };
	phone?: { id?: string };
	acsUser?: { id?: string };
}

export interface GraphParticipant {
	identity?: GraphIdentity;
}

/** The subset of a Graph callRecord this platform reads. */
export interface GraphCallRecord {
	id: string;
	version?: number;
	type?: string;
	modalities?: string[];
	startDateTime?: string;
	endDateTime?: string;
	organizer_v2?: GraphParticipant;
	participants_v2?: GraphParticipant[];
}

export interface MappedCall {
	externalId: string;
	direction: "in" | "out";
	/** The outside party's number, as Microsoft reported it. */
	externalNumber: string | null;
	/** The ABC Cargo person on the call, by user principal name. */
	agentUpn: string | null;
	startedAt: string;
	durationSeconds: number;
}

/**
 * Turns a Graph call record into the fields a `calls` row needs.
 *
 * Direction is inferred from who organised the call: a record organised by a
 * phone number is someone ringing us, one organised by a directory user is us
 * ringing out. This is a heuristic and is written down as one — it should be
 * checked against real UK traffic before anyone relies on the direction in a
 * report.
 */
export function mapCallRecord(record: GraphCallRecord): MappedCall {
	const participants = [
		...(record.organizer_v2 ? [record.organizer_v2] : []),
		...(record.participants_v2 ?? []),
	];

	const phone = participants.find((p) => p.identity?.phone?.id)?.identity?.phone
		?.id;
	const user = participants.find((p) => p.identity?.user?.userPrincipalName)
		?.identity?.user;

	const organiserIsPhone = Boolean(record.organizer_v2?.identity?.phone?.id);

	return {
		externalId: record.id,
		direction: organiserIsPhone ? "in" : "out",
		externalNumber: phone ?? null,
		agentUpn: user?.userPrincipalName ?? null,
		startedAt: record.startDateTime ?? new Date().toISOString(),
		durationSeconds: durationOf(record.startDateTime, record.endDateTime),
	};
}

function durationOf(start?: string, end?: string): number {
	if (!start || !end) return 0;
	const from = Date.parse(start);
	const to = Date.parse(end);
	if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
	return Math.round((to - from) / 1000);
}

/* ------------------------------------------------------------------ matching */

/**
 * Reduces a number to its digits so two spellings of one number compare equal.
 * `+44 7700 900214`, `0044-7700-900214` and `tel:+447700900214` all collapse to
 * `447700900214`.
 *
 * A leading `00` is an international prefix and is dropped. A single leading
 * `0` is a national trunk prefix and cannot be resolved without knowing the
 * country, so it is left alone and handled by `candidateKeys` instead.
 */
export function normaliseNumber(value: string | null | undefined): string {
	if (!value) return "";
	let digits = value.replace(/[^\d+]/g, "");
	digits = digits.replace(/\+/g, "");
	if (digits.startsWith("00")) digits = digits.slice(2);
	return digits;
}

/**
 * The forms a stored customer number might take for one dialled number.
 *
 * Customers are stored with whatever a colleague typed, and a UK mobile is
 * written `+44 7700 900214` by one person and `07700 900214` by the next. Both
 * must find the same customer, so a national form is offered alongside the
 * international one when the country code is known.
 */
export function candidateKeys(
	value: string | null | undefined,
	countryCode?: string,
): string[] {
	const full = normaliseNumber(value);
	if (!full) return [];
	const keys = new Set<string>([full]);
	if (countryCode && full.startsWith(countryCode)) {
		keys.add(`0${full.slice(countryCode.length)}`);
		keys.add(full.slice(countryCode.length));
	}
	if (full.startsWith("0")) {
		const national = full.replace(/^0+/, "");
		if (countryCode) keys.add(`${countryCode}${national}`);
		keys.add(national);
	}
	return [...keys].filter(Boolean);
}

/** Dialling codes per region, for turning a national number international. */
export const REGION_DIALLING_CODES: Record<string, string> = {
	uae: "971",
	ksa: "966",
	uk: "44",
};

export interface CustomerNumber {
	id: string;
	phone?: string | null;
	waId?: string | null;
}

/**
 * Finds the one customer a number belongs to.
 *
 * Returns null when nothing matches, and — deliberately — also when more than
 * one customer matches. Two customers sharing a switchboard number is exactly
 * the case where guessing writes a call onto the wrong company's history, so
 * an ambiguous match is treated as no match and left for an agent.
 */
export function matchCustomer(
	externalNumber: string | null,
	customers: CustomerNumber[],
	regionId?: string,
): CustomerNumber | null {
	const keys = new Set(
		candidateKeys(
			externalNumber,
			regionId ? REGION_DIALLING_CODES[regionId] : undefined,
		),
	);
	if (keys.size === 0) return null;

	const hits = customers.filter((c) => {
		for (const stored of [c.phone, c.waId]) {
			const storedKeys = candidateKeys(
				stored,
				regionId ? REGION_DIALLING_CODES[regionId] : undefined,
			);
			if (storedKeys.some((k) => keys.has(k))) return true;
		}
		return false;
	});

	return hits.length === 1 ? (hits[0] ?? null) : null;
}

/* ---------------------------------------------------------------- transcript */

/**
 * Microsoft returns a transcript as WebVTT. The timings matter to a media
 * player and not to a customer history, so this keeps the speaker and the
 * words and drops everything else.
 *
 * Consecutive cues from one speaker are joined, because WebVTT breaks a single
 * sentence across cues wherever the audio paused, and a history full of
 * three-word lines is harder to read than the call was to hear.
 */
export function vttToText(vtt: string): string {
	const lines = vtt.replace(/\r\n/g, "\n").split("\n");
	const out: { speaker: string; text: string }[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (!line) continue;
		if (line === "WEBVTT" || line.startsWith("NOTE")) continue;
		// Cue timing, e.g. 00:00:03.520 --> 00:00:07.000
		if (!line.includes("-->")) continue;

		// Everything up to the next blank line is this cue's payload.
		const payload: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const next = (lines[j] ?? "").trim();
			if (!next) break;
			payload.push(next);
		}
		if (payload.length === 0) continue;

		const joined = payload.join(" ");
		// Microsoft labels the speaker with <v Display Name>text</v>.
		const voice = joined.match(/^<v\s+([^>]*)>([\s\S]*?)(?:<\/v>)?$/);
		const speaker = voice ? (voice[1] ?? "").trim() : "";
		const text = (voice ? (voice[2] ?? "") : joined)
			.replace(/<[^>]+>/g, "")
			.trim();
		if (!text) continue;

		const last = out[out.length - 1];
		if (last && last.speaker === speaker) last.text += ` ${text}`;
		else out.push({ speaker, text });
	}

	return out
		.map((t) => (t.speaker ? `${t.speaker}: ${t.text}` : t.text))
		.join("\n");
}

/**
 * A one-line summary for the activity stream. The full text lives in
 * `call_transcripts`; a timeline needs something readable at a glance.
 */
export function transcriptPreview(text: string, limit = 160): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= limit) return flat;
	return `${flat.slice(0, limit - 1)}…`;
}
