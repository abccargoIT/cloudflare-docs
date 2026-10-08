import { test } from "node:test";
import assert from "node:assert/strict";
import {
	canEditMessage,
	canPostToThread,
	canReadThread,
	canStartDirect,
	directKey,
	unreadCount,
	type ThreadRef,
} from "../src/chat/policy.ts";
import type { Caller } from "../src/auth/policy.ts";

function person(id: string, overrides: Partial<Caller> = {}): Caller {
	return {
		kind: "user",
		id,
		email: `${id}@example.invalid`,
		displayName: id,
		role: "agent",
		status: "active",
		regionIds: ["uae"],
		teamIds: ["team_uae_sales"],
		...overrides,
	} as Caller;
}

const service: Caller = { kind: "service", name: "shipment-system" };

const thread: ThreadRef = {
	id: "thr_1",
	kind: "direct",
	participantIds: ["usr_mariam", "usr_aziz"],
};

/* ------------------------------------------------------------- membership */

test("a participant reads the thread; a stranger does not", () => {
	assert.equal(canReadThread(person("usr_mariam"), thread).allowed, true);
	assert.equal(canReadThread(person("usr_aziz"), thread).allowed, true);
	assert.equal(
		canReadThread(person("usr_omar"), thread).reason,
		"not_a_participant",
	);
});

test("a master admin has no back door into colleagues' messages", () => {
	// They can add themselves, which leaves a record. Reading silently would
	// not, and that is the difference worth keeping.
	const admin = person("usr_admin", { role: "master_admin" });
	assert.equal(canReadThread(admin, thread).reason, "not_a_participant");
});

test("a team lead gets no special reach either", () => {
	const lead = person("usr_lead", {
		role: "team_lead",
		regionIds: ["uae", "ksa"],
	});
	assert.equal(canReadThread(lead, thread).reason, "not_a_participant");
});

test("a machine credential has no place in a staff conversation", () => {
	// Everything else in the platform lets a service principal through,
	// because the shipment system needs to write milestones. Nothing needs to
	// read what colleagues said to each other.
	assert.equal(canReadThread(service, thread).reason, "service_caller");
	assert.equal(
		canPostToThread(service, thread, "hello").reason,
		"service_caller",
	);
	assert.equal(canStartDirect(service, "usr_aziz").reason, "service_caller");
});

test("a suspended person is refused even while still a participant", () => {
	const suspended = person("usr_mariam", { status: "suspended" });
	assert.equal(canReadThread(suspended, thread).reason, "suspended");
	assert.equal(canPostToThread(suspended, thread, "hi").reason, "suspended");
});

/* ----------------------------------------------------------------- region */

test("threads cross regions on purpose", () => {
	// A UAE agent asking a KSA colleague about a shipment is the reason this
	// module exists; the regional rules governing customer data do not apply.
	const uaeAgent = person("usr_mariam", { regionIds: ["uae"] });
	const ksaThread: ThreadRef = {
		id: "thr_2",
		kind: "team",
		teamId: "team_ksa_sales",
		participantIds: ["usr_mariam", "usr_aziz"],
	};
	assert.equal(canReadThread(uaeAgent, ksaThread).allowed, true);
	assert.equal(canStartDirect(uaeAgent, "usr_aziz").allowed, true);
});

/* ---------------------------------------------------------------- posting */

test("an empty message is refused rather than stored", () => {
	const mariam = person("usr_mariam");
	assert.equal(canPostToThread(mariam, thread, "  ").reason, "empty_message");
	assert.equal(canPostToThread(mariam, thread, "\n\t").reason, "empty_message");
	assert.equal(canPostToThread(mariam, thread, "ok").allowed, true);
});

test("only the author may edit their message", () => {
	// A supervisor removing something is a deletion: a different act, with a
	// different record. Rewriting a colleague's words under their name is not
	// something to make easy.
	assert.equal(
		canEditMessage(person("usr_mariam"), thread, "usr_mariam").allowed,
		true,
	);
	assert.equal(
		canEditMessage(person("usr_aziz"), thread, "usr_mariam").reason,
		"not_the_author",
	);
	assert.equal(
		canEditMessage(person("usr_omar"), thread, "usr_omar").reason,
		"not_a_participant",
	);
});

/* ------------------------------------------------------------- direct key */

test("a direct thread is found from either end", () => {
	// Without this, two colleagues messaging at the same moment get two
	// threads and each sees half the conversation.
	assert.equal(directKey("usr_a", "usr_b"), directKey("usr_b", "usr_a"));
	assert.equal(directKey("usr_a", "usr_b"), "usr_a|usr_b");
});

test("a direct thread needs two different people", () => {
	assert.throws(() => directKey("usr_a", "usr_a"));
	assert.throws(() => directKey("", "usr_b"));
	assert.equal(
		canStartDirect(person("usr_a"), "usr_a").reason,
		"not_a_participant",
	);
	assert.equal(canStartDirect(person("usr_a"), "").reason, "not_a_participant");
});

/* ----------------------------------------------------------------- unread */

test("unread counts from the reader's own mark, not a flag on the message", () => {
	const messages = [
		{ createdAt: "2026-10-08T09:00:00Z", authorId: "usr_aziz" },
		{ createdAt: "2026-10-08T10:00:00Z", authorId: "usr_aziz" },
		{ createdAt: "2026-10-08T11:00:00Z", authorId: "usr_mariam" },
		{ createdAt: "2026-10-08T12:00:00Z", authorId: "usr_aziz" },
	];
	// Mariam read up to 10:00, so one earlier message is read, one later is
	// not, and her own does not count.
	assert.equal(unreadCount(messages, "2026-10-08T10:00:00Z", "usr_mariam"), 1);
	// Aziz wrote three of the four; only Mariam's is unread to him.
	assert.equal(unreadCount(messages, null, "usr_aziz"), 1);
	// Never opened: everything but your own.
	assert.equal(unreadCount(messages, null, "usr_mariam"), 3);
});

test("an unreadable mark counts everything rather than nothing", () => {
	// Failing towards "you have not seen this" is the safe direction: the
	// worst case is a badge that should not be there, not a message nobody
	// notices.
	const messages = [
		{ createdAt: "2026-10-08T09:00:00Z", authorId: "usr_aziz" },
	];
	assert.equal(unreadCount(messages, "not-a-date", "usr_mariam"), 1);
	assert.equal(unreadCount(messages, undefined, "usr_mariam"), 1);
	// A message with an unreadable timestamp is not counted, because there is
	// no way to know whether it is new.
	assert.equal(
		unreadCount(
			[{ createdAt: "nonsense", authorId: "usr_aziz" }],
			null,
			"usr_mariam",
		),
		0,
	);
});
