import { test } from "node:test";
import assert from "node:assert/strict";
import {
	NotificationRejected,
	candidateKeys,
	mapCallRecord,
	matchCustomer,
	normaliseNumber,
	parseNotificationBatch,
	transcriptPreview,
	validationTokenFrom,
	vttToText,
} from "../src/telephony/graph.ts";

const SECRET = "a-long-random-client-state";

function notification(overrides: Record<string, unknown> = {}) {
	return {
		subscriptionId: "sub-1",
		changeType: "created",
		resource: "communications/callRecords/abc",
		clientState: SECRET,
		resourceData: { id: "abc" },
		...overrides,
	};
}

/* ------------------------------------------------------------ notifications */

test("echoes the validation token Graph sends when a subscription is created", () => {
	const url = new URL(
		"https://example.invalid/x?validationToken=hello%20there",
	);
	assert.equal(validationTokenFrom(url), "hello there");
	assert.equal(validationTokenFrom(new URL("https://example.invalid/x")), null);
});

test("accepts a notification batch carrying the right client state", () => {
	const parsed = parseNotificationBatch({ value: [notification()] }, SECRET);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0]?.resourceData?.id, "abc");
});

test("rejects a notification whose client state is wrong or missing", () => {
	// The endpoint is public, so this check is the whole of its security.
	for (const bad of [
		{ value: [notification({ clientState: "guess" })] },
		{ value: [notification({ clientState: undefined })] },
		// One good notification does not vouch for a forged one beside it.
		{ value: [notification(), notification({ clientState: "guess" })] },
	]) {
		assert.throws(
			() => parseNotificationBatch(bad, SECRET),
			NotificationRejected,
		);
	}
});

test("rejects malformed bodies and refuses to run without a configured secret", () => {
	assert.throws(
		() => parseNotificationBatch(null, SECRET),
		NotificationRejected,
	);
	assert.throws(() => parseNotificationBatch({}, SECRET), NotificationRejected);
	// An unset secret must fail closed, not match an absent clientState.
	assert.throws(
		() => parseNotificationBatch({ value: [notification()] }, ""),
		NotificationRejected,
	);
});

/* -------------------------------------------------------------- call records */

test("reads an inbound PSTN call: organised by a number, answered by an agent", () => {
	const mapped = mapCallRecord({
		id: "rec-1",
		type: "peerToPeer",
		startDateTime: "2026-10-07T09:00:00Z",
		endDateTime: "2026-10-07T09:03:04Z",
		organizer_v2: { identity: { phone: { id: "+447700900214" } } },
		participants_v2: [
			{ identity: { phone: { id: "+447700900214" } } },
			{
				identity: {
					user: {
						id: "u1",
						displayName: "Mariam",
						userPrincipalName: "mariam@abccargo.invalid",
					},
				},
			},
		],
	});

	assert.equal(mapped.direction, "in");
	assert.equal(mapped.externalNumber, "+447700900214");
	assert.equal(mapped.agentUpn, "mariam@abccargo.invalid");
	assert.equal(mapped.durationSeconds, 184);
});

test("reads an outbound call: organised by one of ours", () => {
	const mapped = mapCallRecord({
		id: "rec-2",
		startDateTime: "2026-10-07T09:00:00Z",
		endDateTime: "2026-10-07T09:00:30Z",
		organizer_v2: {
			identity: {
				user: { id: "u1", userPrincipalName: "mariam@abccargo.invalid" },
			},
		},
		participants_v2: [{ identity: { phone: { id: "+971506621184" } } }],
	});

	assert.equal(mapped.direction, "out");
	assert.equal(mapped.externalNumber, "+971506621184");
	assert.equal(mapped.durationSeconds, 30);
});

test("survives a call record with pieces missing", () => {
	const mapped = mapCallRecord({ id: "rec-3" });
	assert.equal(mapped.externalNumber, null);
	assert.equal(mapped.agentUpn, null);
	assert.equal(mapped.durationSeconds, 0);
	// An end before the start is nonsense, not a negative call.
	assert.equal(
		mapCallRecord({
			id: "rec-4",
			startDateTime: "2026-10-07T09:05:00Z",
			endDateTime: "2026-10-07T09:00:00Z",
		}).durationSeconds,
		0,
	);
});

/* ------------------------------------------------------------------ matching */

test("normalises the ways one number gets written", () => {
	assert.equal(normaliseNumber("+44 7700 900214"), "447700900214");
	assert.equal(normaliseNumber("0044-7700-900214"), "447700900214");
	assert.equal(normaliseNumber("tel:+447700900214"), "447700900214");
	assert.equal(normaliseNumber(""), "");
	assert.equal(normaliseNumber(undefined), "");
});

test("offers the national form so a locally typed number still matches", () => {
	const keys = candidateKeys("+447700900214", "44");
	assert.ok(keys.includes("447700900214"));
	assert.ok(keys.includes("07700900214"));

	// And the reverse: stored nationally, dialled internationally.
	assert.ok(candidateKeys("07700900214", "44").includes("447700900214"));
});

test("matches a customer across international and national spellings", () => {
	const customers = [
		{ id: "cus_uk", phone: "07700 900214" },
		{ id: "cus_ae", phone: "+971 50 662 1184", waId: "971506621184" },
	];

	assert.equal(matchCustomer("+447700900214", customers, "uk")?.id, "cus_uk");
	assert.equal(matchCustomer("+971506621184", customers, "uae")?.id, "cus_ae");
	assert.equal(matchCustomer("+6512345678", customers, "uk"), null);
	assert.equal(matchCustomer(null, customers, "uk"), null);
});

test("an ambiguous number is no match, not a guess", () => {
	// Two companies behind one switchboard. Writing the call onto either one's
	// history would be a quiet, plausible-looking error.
	const shared = [
		{ id: "cus_a", phone: "+442079460000" },
		{ id: "cus_b", phone: "+44 20 7946 0000" },
	];
	assert.equal(matchCustomer("+442079460000", shared, "uk"), null);
});

/* ---------------------------------------------------------------- transcript */

test("turns Microsoft's WebVTT into readable speaker-labelled text", () => {
	const vtt = [
		"WEBVTT",
		"",
		"NOTE recording started",
		"",
		"00:00:01.000 --> 00:00:04.000",
		"<v Daniel Okoye>Hello, I am calling about my shipment</v>",
		"",
		"00:00:04.100 --> 00:00:06.000",
		"<v Daniel Okoye>reference ABC-UAE-088210.</v>",
		"",
		"00:00:06.500 --> 00:00:09.000",
		"<v Mariam>Of course, let me check that for you.</v>",
		"",
	].join("\n");

	assert.equal(
		vttToText(vtt),
		"Daniel Okoye: Hello, I am calling about my shipment reference ABC-UAE-088210.\n" +
			"Mariam: Of course, let me check that for you.",
	);
});

test("handles a transcript with no speaker labels, and an empty one", () => {
	const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nJust some words\n";
	assert.equal(vttToText(vtt), "Just some words");
	assert.equal(vttToText("WEBVTT\n"), "");
	assert.equal(vttToText(""), "");
});

test("nested angle brackets cannot reassemble into a tag", () => {
	// The trap a single replace() pass falls into: stripping the inner <v>
	// from "<<v>script>" produces the very thing the pass existed to remove.
	const vtt = [
		"WEBVTT",
		"",
		"00:00:01.000 --> 00:00:02.000",
		"<v Caller><<v>script>alert(1)<</v>/script> and then the booking</v>",
		"",
	].join("\n");

	const text = vttToText(vtt);
	assert.ok(!text.includes("<script"), text);
	assert.ok(!text.includes("<"), text);
	assert.ok(!text.includes(">"), text);
	assert.ok(text.includes("and then the booking"), text);
});

test("a speaker name carrying markup is cleaned too", () => {
	const vtt =
		"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n" +
		"<v <<b>script>Bad Name><v>Hello</v>\n";
	const text = vttToText(vtt);
	assert.ok(!text.includes("<"), text);
	assert.ok(!text.includes(">"), text);
});

test("decodes the WebVTT escapes that cannot become markup", () => {
	const vtt =
		"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n" +
		"<v A>Smith &amp; Sons&nbsp;Ltd</v>\n";
	assert.equal(vttToText(vtt), "A: Smith & Sons Ltd");
});

test("previews a transcript without cutting mid-stream silently", () => {
	assert.equal(transcriptPreview("short line"), "short line");
	const long = "a".repeat(400);
	const preview = transcriptPreview(long);
	assert.equal(preview.length, 160);
	assert.ok(preview.endsWith("…"));
});
