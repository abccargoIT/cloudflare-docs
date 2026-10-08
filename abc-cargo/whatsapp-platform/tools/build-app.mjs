/**
 * Builds demo/app.html — the complete ABC Cargo Engage demonstration.
 *
 * One file, opened by double-clicking, no installation, no internet
 * connection, nothing to start. Inside it is the whole working product: the
 * agent inbox for all three regional numbers, leads, quotations, bookings,
 * tickets and calls, with one customer timeline across them.
 *
 * It is a demonstration of the real thing rather than a drawing of it. Every
 * decision on the screen is taken by the platform's own compiled code —
 * intent recognition, service-target clocks on each region's calendar,
 * reference formats, lead and milestone transitions, automated replies. The
 * data lives in the browser instead of the database, and nothing leaves the
 * machine, but the rules are the ones that will run in production.
 *
 * Usage:  npm run build:app
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inlineModules, renderTemplate } from "./lib/inline-source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * Dependency order matters: each file may use names declared above it once
 * the import statements are removed.
 */
const MODULES = [
	"src/regions.ts",
	"src/business-hours.ts",
	"src/auto-reply.ts",
	"src/crm/types.ts",
	"src/crm/intent.ts",
	"src/crm/sla.ts",
	"src/crm/sla-policy.ts",
	"src/crm/refs.ts",
	"src/crm/lifecycle.ts",
	"src/crm/customer-lifecycle.ts",
	"src/auth/policy.ts",
	"src/crm/transfer.ts",
	"src/crm/csat.ts",
	"src/admin/guards.ts",
	"src/chat/policy.ts",
	"src/dashboard/clock.ts",
	"src/dashboard/presence.ts",
	"src/composer/media.ts",
	"src/composer/notes.ts",
	"src/bots/types.ts",
	"src/crm/deflection.ts",
	"src/bots/validate.ts",
	"src/bots/parse.ts",
	"src/bots/runtime.ts",
	"src/bots/templates.ts",
	"src/bots/preview.ts",
	"src/broadcasts/types.ts",
	"src/broadcasts/audience.ts",
	"src/broadcasts/template.ts",
	"src/broadcasts/policy.ts",
];

const { engine, block } = inlineModules(ROOT, MODULES, "npm run build:app");

const html = renderTemplate(join(HERE, "app.template.html"), block);
const outPath = join(ROOT, "demo", "app.html");
writeFileSync(outPath, html, "utf8");

console.log(`Wrote ${outPath}`);
console.log(`Inlined ${MODULES.length} modules, ${engine.length} characters.`);
