import { test } from "node:test";
import assert from "node:assert/strict";
import { WhatsAppClient } from "../src/whatsapp/client.ts";

test("the default fetch is called with the right receiver", async () => {
	// The Workers runtime refuses a fetch whose `this` is anything but the
	// global scope ("Illegal invocation"). Node does not, so this stands in for
	// the runtime's check: without it, a client storing the global fetch as a
	// property and calling it as a method passes every other test and fails
	// every real send.
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = function (this: unknown) {
		if (this !== undefined && this !== globalThis) {
			throw new TypeError("Illegal invocation");
		}
		calls++;
		return Promise.resolve(
			new Response(JSON.stringify({ messages: [{ id: "wamid.test" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
	} as typeof fetch;
	try {
		const client = new WhatsAppClient({
			accessToken: "test-only",
			graphApiVersion: "v23.0",
		});
		const sent = await client.sendText("100000000000001", "971555000000", "hi");
		assert.equal(sent.messages[0]?.id, "wamid.test");
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = original;
	}
});
