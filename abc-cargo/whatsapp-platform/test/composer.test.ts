import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	baseMimeType,
	checkLocation,
	checkMedia,
	rendersAsVoiceNote,
	safeFilename,
} from "../src/composer/media.ts";
import {
	canEditNote,
	checkNoteBody,
	MAX_NOTE_LENGTH,
	type NoteRow,
} from "../src/composer/notes.ts";

/* ------------------------------------------------- notes cannot be sent */

test("the sending code cannot reach the notes table", () => {
	// This is the guarantee the whole design of internal notes rests on, so it
	// is asserted rather than trusted. An internal note delivered to the
	// customer it is about is not a bug anybody recovers from with an apology,
	// and the protection is structural: the send path has no query to get
	// wrong because it does not touch the table.
	for (const file of [
		"src/conversation.ts",
		"src/whatsapp/client.ts",
		"src/broadcasts/sender.ts",
		"src/queue/consumer.ts",
	]) {
		const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
		assert.ok(
			!source.includes("conversation_notes"),
			`${file} must not reference the notes table`,
		);
	}
});

test("the notes module sends nothing anywhere", () => {
	// No WhatsApp client, no phone number, no fetch. If this file ever needs
	// one of those, the design has gone wrong.
	const source = readFileSync(
		new URL("../src/composer/notes.ts", import.meta.url),
		"utf8",
	);
	for (const forbidden of ["WhatsAppClient", "phoneNumberId", "fetch("]) {
		assert.ok(
			!source.includes(forbidden),
			`notes.ts must not contain ${forbidden}`,
		);
	}
});

test("an empty note is refused rather than stored blank", () => {
	assert.equal(checkNoteBody("Customer disputes the duty").ok, true);
	assert.equal(checkNoteBody("   ").ok, false);
	assert.equal(checkNoteBody("").ok, false);
	assert.equal(checkNoteBody(undefined).ok, false);
	const blank = checkNoteBody("  ");
	assert.equal(blank.ok === false && blank.reason, "empty_note");
});

test("only the author rewrites their own note", () => {
	// A supervisor who disagrees adds their own, which leaves both on the
	// record. The same rule as team chat.
	const note: NoteRow = {
		id: "note_1",
		conversation_id: "c1",
		region_id: "uae",
		author_id: "usr_mariam",
		body: "Watch the duty on this one",
		pinned: 0,
		created_at: "2026-10-08T09:00:00Z",
		edited_at: null,
	};
	assert.equal(canEditNote("usr_mariam", note).ok, true);
	const other = canEditNote("usr_aziz", note);
	assert.equal(other.ok, false);
	assert.equal(other.ok === false && other.reason, "not_the_author");
});

test("a note is long enough to be useful and short enough not to be a document", () => {
	assert.equal(MAX_NOTE_LENGTH, 4000);
});

/* ----------------------------------------------------------- attachments */

test("an oversized attachment is refused before it is uploaded", () => {
	// Meta would reject it too, but only after the upload — which on a large
	// file is a minute of waiting for an error that reads like a server fault.
	const tooBig = checkMedia({
		kind: "image",
		mimeType: "image/jpeg",
		sizeBytes: 6 * 1024 * 1024,
	});
	assert.equal(tooBig.ok, false);
	assert.equal(tooBig.ok === false && tooBig.reason, "too_large");
	assert.match(tooBig.ok === false ? tooBig.message : "", /5 MB/);
	assert.match(tooBig.ok === false ? tooBig.message : "", /6 MB/);
	// Read by an agent, so the article matters.
	assert.match(tooBig.ok === false ? tooBig.message : "", /^an image/);
});

test("an empty file is refused", () => {
	const empty = checkMedia({
		kind: "document",
		mimeType: "application/pdf",
		sizeBytes: 0,
		filename: "invoice.pdf",
	});
	assert.equal(empty.ok === false && empty.reason, "empty_file");
});

test("an image must be one of the types WhatsApp renders", () => {
	assert.equal(
		checkMedia({ kind: "image", mimeType: "image/jpeg", sizeBytes: 1000 }).ok,
		true,
	);
	const gif = checkMedia({
		kind: "image",
		mimeType: "image/gif",
		sizeBytes: 1000,
	});
	assert.equal(gif.ok === false && gif.reason, "wrong_type");
});

test("documents are deliberately open about their type", () => {
	// An agent sending a customs declaration should not be stopped because
	// nobody thought to list that file type.
	for (const mimeType of [
		"application/pdf",
		"application/vnd.ms-excel",
		"application/x-something-nobody-listed",
	]) {
		const check = checkMedia({
			kind: "document",
			mimeType,
			sizeBytes: 1000,
			filename: "doc.bin",
		});
		assert.equal(check.ok, true, mimeType);
	}
});

test("a document without a filename is refused", () => {
	// It is what the customer sees in the chat. An unnamed commercial invoice
	// is unhelpful and looks like a mistake on our part.
	const check = checkMedia({
		kind: "document",
		mimeType: "application/pdf",
		sizeBytes: 1000,
	});
	assert.equal(check.ok === false && check.reason, "missing_filename");
	assert.match(
		check.ok === false ? check.message : "",
		/what the customer sees/,
	);
});

test("an unknown attachment kind is refused", () => {
	const check = checkMedia({
		kind: "spreadsheet",
		mimeType: "application/pdf",
		sizeBytes: 10,
	});
	assert.equal(check.ok === false && check.reason, "unknown_kind");
});

/* ----------------------------------------------------------- voice notes */

test("only Ogg Opus arrives as a voice note", () => {
	// Every other audio type arrives as a file with a play button, which is a
	// different thing to receive.
	assert.equal(rendersAsVoiceNote("audio/ogg"), true);
	assert.equal(rendersAsVoiceNote("audio/ogg; codecs=opus"), true);
	assert.equal(rendersAsVoiceNote('audio/ogg; codecs="opus"'), true);
	assert.equal(rendersAsVoiceNote("AUDIO/OGG; CODECS=OPUS"), true);
	assert.equal(rendersAsVoiceNote("audio/ogg; codecs=vorbis"), false);
	assert.equal(rendersAsVoiceNote("audio/mpeg"), false);
	assert.equal(rendersAsVoiceNote("audio/mp4"), false);
});

test("the agent is told which one they are about to send", () => {
	// An agent who records a voice note and sees it arrive as "audio.m4a"
	// concludes the feature is broken.
	const voice = checkMedia({
		kind: "audio",
		mimeType: "audio/ogg; codecs=opus",
		sizeBytes: 50_000,
	});
	assert.equal(voice.ok, true);
	assert.equal(voice.ok === true && voice.voiceNote, true);
	assert.deepEqual(voice.ok === true && voice.warnings, []);

	const file = checkMedia({
		kind: "audio",
		mimeType: "audio/mpeg",
		sizeBytes: 50_000,
	});
	assert.equal(file.ok, true);
	assert.equal(file.ok === true && file.voiceNote, false);
	assert.match(
		file.ok === true ? file.warnings.join(" ") : "",
		/audio file, not a voice note/,
	);
});

/* ------------------------------------------------------------- filenames */

test("a filename is reduced to something safe to show a customer", () => {
	// An agent attaching C:\Users\mariam\invoice.pdf meant invoice.pdf.
	assert.equal(safeFilename("C:\\Users\\mariam\\invoice.pdf"), "invoice.pdf");
	assert.equal(safeFilename("/tmp/packing list.pdf"), "packing list.pdf");
	assert.equal(safeFilename("../../etc/passwd"), "passwd");
	assert.equal(safeFilename("invoice\u0000.pdf"), "invoice.pdf");
	assert.equal(safeFilename("  spaced.pdf  "), "spaced.pdf");
	assert.equal(safeFilename("/"), undefined);
	assert.equal(safeFilename(".."), undefined);
	assert.equal(safeFilename(""), undefined);
	assert.equal(safeFilename(undefined), undefined);
	assert.equal(safeFilename("a".repeat(300))?.length, 240);
});

test("an adjusted filename is reported rather than changed silently", () => {
	const check = checkMedia({
		kind: "document",
		mimeType: "application/pdf",
		sizeBytes: 1000,
		filename: "C:\\invoices\\ABC-UAE-088210.pdf",
	});
	assert.equal(check.ok, true);
	assert.equal(check.ok === true && check.filename, "ABC-UAE-088210.pdf");
	assert.match(
		check.ok === true ? check.warnings.join(" ") : "",
		/filename was adjusted/,
	);
});

test("the media type is read without its parameters", () => {
	assert.equal(baseMimeType("audio/ogg; codecs=opus"), "audio/ogg");
	assert.equal(baseMimeType("IMAGE/JPEG"), "image/jpeg");
	assert.equal(baseMimeType("  application/pdf  "), "application/pdf");
	assert.equal(baseMimeType(""), "");
});

/* -------------------------------------------------------------- location */

test("a location outside the world is refused", () => {
	assert.equal(checkLocation({ latitude: 25.2, longitude: 55.3 }).ok, true);
	for (const bad of [
		{ latitude: 91, longitude: 0 },
		{ latitude: -91, longitude: 0 },
		{ latitude: 0, longitude: 181 },
		{ latitude: 0, longitude: -181 },
	]) {
		const check = checkLocation(bad);
		assert.equal(
			check.ok === false && check.reason,
			"out_of_range",
			JSON.stringify(bad),
		);
	}
});

test("coordinates that are not numbers are refused", () => {
	for (const bad of [
		{ latitude: "here", longitude: "there" },
		{ latitude: undefined, longitude: 55 },
		{ latitude: Number.NaN, longitude: 55 },
	]) {
		const check = checkLocation(bad);
		assert.equal(check.ok === false && check.reason, "not_a_number");
	}
	// A numeric string is accepted: it is what a form sends.
	assert.equal(checkLocation({ latitude: "25.2", longitude: "55.3" }).ok, true);
});

test("0, 0 is treated as an empty coordinate rather than a place", () => {
	// It is in the Gulf of Guinea, and it is almost always an uninitialised
	// value rather than somewhere anybody meant to send.
	const check = checkLocation({ latitude: 0, longitude: 0 });
	assert.equal(check.ok === false && check.reason, "null_island");
});

test("a named location needs an address to navigate to", () => {
	// WhatsApp shows the name as a heading and the address beneath it. A name
	// alone renders as a labelled pin with no way to find it, which for a
	// warehouse is the one thing the customer needs.
	const named = checkLocation({
		latitude: 25.2,
		longitude: 55.3,
		name: "ABC Cargo Warehouse",
	});
	assert.equal(named.ok === false && named.reason, "name_without_address");

	const full = checkLocation({
		latitude: 25.2,
		longitude: 55.3,
		name: "ABC Cargo Warehouse",
		address: "Jebel Ali Free Zone, Dubai",
	});
	assert.equal(full.ok, true);
	assert.equal(full.ok === true && full.name, "ABC Cargo Warehouse");

	// An address with no name is fine: the address is the useful half.
	assert.equal(
		checkLocation({
			latitude: 25.2,
			longitude: 55.3,
			address: "Jebel Ali Free Zone, Dubai",
		}).ok,
		true,
	);
});
