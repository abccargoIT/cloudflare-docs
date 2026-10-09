/**
 * Builds demo/message-tester.html — a single file that can be opened by
 * double-clicking it, with no installation and no internet connection.
 *
 * The page runs the platform's OWN decision code, inlined at build time by
 * tools/lib/inline-source.mjs, so the page cannot drift from the source.
 *
 * Usage:  npm run build:tester
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inlineModules, renderTemplate } from "./lib/inline-source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const MODULES = [
	"src/business-hours.ts",
	"src/auto-reply.ts",
	"src/crm/types.ts",
	"src/crm/intent.ts",
	"src/crm/sla.ts",
];

const { engine, block } = inlineModules(ROOT, MODULES, "npm run build:tester");

const html = renderTemplate(join(HERE, "message-tester.template.html"), block);
const outPath = join(ROOT, "demo", "message-tester.html");
writeFileSync(outPath, html, "utf8");

console.log(`Wrote ${outPath}`);
console.log(`Inlined ${MODULES.length} modules, ${engine.length} characters.`);
