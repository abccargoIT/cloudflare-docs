/**
 * Builds demo/message-tester.html — a single file that can be opened by
 * double-clicking it, with no installation and no internet connection.
 *
 * The page runs the platform's OWN decision code. This script compiles the
 * relevant TypeScript modules to plain JavaScript and inlines them, so the
 * page cannot drift from the source: if the rules change, rebuilding the page
 * changes with them. Nothing is re-implemented by hand.
 *
 * Usage:  npm run build:tester
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * Dependency order matters: each file may use names declared above it once the
 * import statements are removed.
 */
const MODULES = [
	"src/business-hours.ts",
	"src/auto-reply.ts",
	"src/crm/types.ts",
	"src/crm/intent.ts",
	"src/crm/sla.ts",
];

/** Compiles one TypeScript file to JavaScript, erasing all type syntax. */
function compile(relativePath) {
	const source = readFileSync(join(ROOT, relativePath), "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			removeComments: false,
		},
		fileName: relativePath,
	});
	return output.outputText;
}

/**
 * Flattens the compiled modules into one scope. Imports between them are
 * dropped because every name ends up in the same module; `export` keywords are
 * dropped for the same reason.
 */
function flatten(javascript) {
	return (
		javascript
			// import { a, b } from "./x.ts";  /  import "./x.ts";
			.replace(/^\s*import\s[\s\S]*?from\s*["'][^"']+["']\s*;?\s*$/gm, "")
			.replace(/^\s*import\s*["'][^"']+["']\s*;?\s*$/gm, "")
			// export const / function / class ...
			.replace(/^\s*export\s+(?=(const|let|var|function|class|async))/gm, "")
			// export { a, b };
			.replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, "")
			.replace(/^\s*export\s+default\s+/gm, "")
	);
}

const pieces = [];
for (const relativePath of MODULES) {
	pieces.push(
		`/* ---------- ${relativePath} ---------- */`,
		flatten(compile(relativePath)).trim(),
		"",
	);
}

const engine = pieces.join("\n");

const templatePath = join(HERE, "message-tester.template.html");
const template = readFileSync(templatePath, "utf8");
if (!template.includes("/*__ENGINE__*/")) {
	console.error(
		`${templatePath} no longer contains the /*__ENGINE__*/ marker.`,
	);
	process.exit(1);
}

const banner = [
	"/*",
	" * DO NOT EDIT THIS BLOCK.",
	" * Compiled from the platform source by tools/build-tester.mjs:",
	...MODULES.map((m) => ` *   ${m}`),
	" * Rebuild with: npm run build:tester",
	" */",
].join("\n");

const html = template.replace("/*__ENGINE__*/", `${banner}\n\n${engine}`);
const outPath = join(ROOT, "demo", "message-tester.html");
writeFileSync(outPath, html, "utf8");

console.log(`Wrote ${outPath}`);
console.log(`Inlined ${MODULES.length} modules, ${engine.length} characters.`);
