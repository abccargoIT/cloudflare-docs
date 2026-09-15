/**
 * Sends a pretend WhatsApp message to the locally running platform, then shows
 * what the platform did with it.
 *
 * Nothing here touches Meta or any live system. It builds the same JSON that
 * Meta's webhook sends, signs it with the local test secret exactly the way
 * Meta signs a real delivery, and posts it to http://127.0.0.1:8787. If the
 * signature check were broken, this would be rejected — so the check is
 * genuinely exercised, not bypassed.
 *
 * Usage:
 *   node tools/simulate-inbound.mjs                       (runs every scenario)
 *   node tools/simulate-inbound.mjs claim                 (runs one scenario)
 *   node tools/simulate-inbound.mjs --text "where is ABC-UAE-088210"
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BASE = process.env.ENGAGE_URL ?? "http://127.0.0.1:8787";

/* ------------------------------------------------------------ local config */

/** Reads KEY = "value" pairs out of .dev.vars without adding a dependency. */
function readDevVars() {
	let raw;
	try {
		raw = readFileSync(join(ROOT, ".dev.vars"), "utf8");
	} catch {
		fail(
			"Could not read .dev.vars.\n" +
				"Copy .dev.vars.example to .dev.vars first, then run this again.",
		);
	}
	const vars = {};
	for (const line of raw.split(/\r?\n/)) {
		const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		let value = match[2].trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		vars[match[1]] = value;
	}
	return vars;
}

const vars = readDevVars();
const APP_SECRET = vars.WHATSAPP_APP_SECRET;
const API_KEY = vars.INTERNAL_API_KEY;
if (!APP_SECRET || !API_KEY) {
	fail("`.dev.vars` must set WHATSAPP_APP_SECRET and INTERNAL_API_KEY.");
}

let regions;
try {
	regions = JSON.parse(vars.REGION_NUMBERS ?? "[]");
} catch {
	fail("REGION_NUMBERS in .dev.vars is not valid JSON.");
}
const regionById = Object.fromEntries(regions.map((r) => [r.id, r]));

/* ---------------------------------------------------------------- scenarios */

const SCENARIOS = [
	{
		key: "rate",
		region: "uae",
		from: "971555986003",
		name: "Meera Raghavan",
		text: "Hello, how much to send 40 kg from Sharjah to Chennai?",
		expect: "A sales lead is created, even though this person has never written before.",
	},
	{
		key: "claim",
		region: "ksa",
		from: "966507742201",
		name: "Abdulaziz Al Harbi",
		text: "One carton of ABC-KSA-030488 arrived open and two shirts are missing",
		expect:
			"A claim ticket is opened, linked to that shipment, with a response clock already running.",
	},
	{
		key: "track",
		region: "uae",
		from: "971506621184",
		name: "Rashid Al Marzooqi",
		text: "Where is my shipment ABC-UAE-088210?",
		expect:
			"No ticket and no lead. The message is recorded against the existing shipment.",
	},
	{
		key: "arabic",
		region: "ksa",
		from: "966501112222",
		name: "Sara Al Qahtani",
		text: "السلام عليكم، أحتاج سعر شحن إلى مانيلا",
		expect: "An Arabic rate enquiry is recognised and becomes a lead.",
	},
];

/* ---------------------------------------------------------------- webhook */

function buildPayload(scenario) {
	const region = regionById[scenario.region];
	if (!region) fail(`Region "${scenario.region}" is not in REGION_NUMBERS.`);
	const now = Math.floor(Date.now() / 1000);
	return {
		object: "whatsapp_business_account",
		entry: [
			{
				id: "0",
				changes: [
					{
						field: "messages",
						value: {
							messaging_product: "whatsapp",
							metadata: {
								display_phone_number: region.displayNumber,
								phone_number_id: region.phoneNumberId,
							},
							contacts: [
								{
									profile: { name: scenario.name },
									wa_id: scenario.from,
								},
							],
							messages: [
								{
									from: scenario.from,
									id: `wamid.SIM.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
									timestamp: String(now),
									type: "text",
									text: { body: scenario.text },
								},
							],
						},
					},
				],
			},
		],
	};
}

async function sendWebhook(scenario) {
	const body = JSON.stringify(buildPayload(scenario));
	const signature =
		"sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
	const response = await fetch(`${BASE}/webhooks/whatsapp`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Hub-Signature-256": signature,
		},
		body,
	});
	return { status: response.status, text: await response.text() };
}

async function api(path) {
	const response = await fetch(`${BASE}${path}`, {
		headers: { Authorization: `Bearer ${API_KEY}` },
	});
	if (!response.ok) {
		return { error: `${response.status} ${await response.text()}` };
	}
	return response.json();
}

/* -------------------------------------------------------------------- run */

async function checkServer() {
	try {
		const response = await fetch(`${BASE}/health`);
		if (response.ok) return;
		fail(`The platform answered ${response.status} at ${BASE}/health.`);
	} catch {
		fail(
			`Nothing is answering at ${BASE}.\n` +
				"Start the platform first, in a separate window:\n\n" +
				"    npm run dev\n",
		);
	}
}

/** Gives the queue a moment to process, then reports what appeared. */
async function settle(ms = 1500) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function line(char = "─", width = 64) {
	return char.repeat(width);
}

async function runScenario(scenario) {
	console.log(`\n${line()}`);
	console.log(`SCENARIO: ${scenario.key}`);
	console.log(line());
	console.log(`Customer writes to ${regionById[scenario.region].displayNumber}:`);
	console.log(`  "${scenario.text}"`);
	console.log(`\nExpected: ${scenario.expect}`);

	const result = await sendWebhook(scenario);
	console.log(
		`\nDelivered to the platform. It replied ${result.status} ${result.text.trim()}`,
	);
	if (result.status !== 200) {
		console.log("The platform rejected the message. Nothing further to show.");
		return;
	}

	await settle();

	const customerId = `cus_${scenario.from}`;
	const view = await api(`/api/customers/${customerId}?activities=10`);
	if (view.error) {
		console.log(`\nCould not read the customer back: ${view.error}`);
		return;
	}
	if (!view.customer) {
		console.log(
			"\nNo customer record appeared yet. If this persists, the queue may not " +
				"be running locally — see TESTING.md.",
		);
		return;
	}

	console.log(`\nWhat the platform did:`);
	console.log(`  Customer   ${view.customer.display_name} (${view.customer.region_id})`);
	console.log(`  Leads      ${describe(view.leads, (l) => `${l.ref} · ${l.stage}`)}`);
	console.log(
		`  Tickets    ${describe(view.tickets, (t) => `${t.ref} · ${t.type} · due ${short(t.resolution_due_at)}`)}`,
	);
	console.log(
		`  Bookings   ${describe(view.bookings, (b) => `${b.ref} · ${b.milestone}`)}`,
	);
	console.log(`\n  Timeline (newest first):`);
	for (const a of view.activities.slice(0, 5)) {
		console.log(`    ${short(a.occurred_at)}  ${a.kind.padEnd(10)} ${a.summary}`);
	}
}

function describe(rows, format) {
	if (!rows || rows.length === 0) return "none";
	return rows.map(format).join("; ");
}

function short(iso) {
	return typeof iso === "string" ? iso.slice(0, 16).replace("T", " ") : "—";
}

function fail(message) {
	console.error(`\n${message}\n`);
	process.exit(1);
}

async function main() {
	const args = process.argv.slice(2);
	await checkServer();

	const textFlag = args.indexOf("--text");
	if (textFlag !== -1) {
		const text = args[textFlag + 1];
		if (!text) fail('--text needs a message, for example: --text "hello"');
		await runScenario({
			key: "custom",
			region: args.includes("--region")
				? args[args.indexOf("--region") + 1]
				: "uae",
			from: "971555000000",
			name: "Test Customer",
			text,
			expect: "Whatever the classifier makes of it.",
		});
	} else {
		const wanted = args.filter((a) => !a.startsWith("--"));
		const chosen = wanted.length
			? SCENARIOS.filter((s) => wanted.includes(s.key))
			: SCENARIOS;
		if (chosen.length === 0) {
			fail(`No such scenario. Available: ${SCENARIOS.map((s) => s.key).join(", ")}`);
		}
		for (const scenario of chosen) await runScenario(scenario);
	}

	console.log(`\n${line("═")}`);
	console.log("Done. Nothing here reached Meta or any live ABC Cargo system.");
	console.log(line("═"));
}

await main();
