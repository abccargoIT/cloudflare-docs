/**
 * Shared helper for the pages in `demo/` that run the platform's own code.
 *
 * Those pages must open by double-clicking, with no installation and no
 * internet connection, while still executing the real decision logic. The way
 * to have both is to compile the TypeScript sources to plain JavaScript at
 * build time and inline the result. Nothing is re-implemented by hand, so a
 * page cannot drift from the source: change a rule, rebuild, and the page
 * changes with it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** Compiles one TypeScript file to JavaScript, erasing all type syntax. */
function compile(root, relativePath) {
	const source = readFileSync(join(root, relativePath), "utf8");
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
 * Flattens compiled modules into one scope. Imports between them are dropped
 * because every name ends up in the same module; `export` keywords are
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

/**
 * Interface guard, prepended to every built page.
 *
 * This keeps the demonstration looking like a finished product: no context
 * menu, no view-source shortcut, no accidental drag of a panel onto the
 * desktop mid-presentation.
 *
 * It is presentation, not protection, and the comment says so on the page
 * itself. Anyone who wants the source can open the .html file in Notepad —
 * the whole application is inside it. Nothing here should ever be mistaken
 * for a security control, and no secret should ever be put in a built page
 * on the strength of it.
 *
 * Two deliberate exceptions: form fields keep their context menu so an agent
 * can still paste a reference, and nothing blocks ordinary text selection,
 * because reading a shipment number off the screen and copying it is the
 * job.
 */
const INTERFACE_GUARD = `/*
 * Presentation guard. NOT a security control — this file contains the whole
 * application, and any text editor will show it. It exists so a demonstration
 * behaves like a product rather than a web page.
 */
(function () {
	const isField = (el) =>
		el && el.closest && el.closest("input, textarea, [contenteditable]");

	document.addEventListener("contextmenu", (event) => {
		// Form fields keep their menu, so paste still works.
		if (isField(event.target)) return;
		event.preventDefault();
	});

	document.addEventListener("keydown", (event) => {
		const key = (event.key || "").toLowerCase();
		const ctrlish = event.ctrlKey || event.metaKey;

		if (key === "f12") return event.preventDefault();
		if (ctrlish && event.shiftKey && ["i", "j", "c"].includes(key)) {
			return event.preventDefault();
		}
		// View source. Everything else under Ctrl stays available, so an agent
		// can still copy, paste, find and print.
		if (ctrlish && !event.shiftKey && key === "u" && !isField(event.target)) {
			return event.preventDefault();
		}
	});

	document.addEventListener("dragstart", (event) => {
		if (!isField(event.target)) event.preventDefault();
	});
})();`;

/**
 * Compiles and concatenates `modules` (paths relative to `root`) into a single
 * block of JavaScript, prefixed with a banner naming its provenance.
 *
 * Dependency order matters: each file may use names declared above it once the
 * import statements are removed.
 */
export function inlineModules(root, modules, rebuildCommand) {
	const pieces = [];
	for (const relativePath of modules) {
		pieces.push(
			`/* ---------- ${relativePath} ---------- */`,
			flatten(compile(root, relativePath)).trim(),
			"",
		);
	}
	const engine = [INTERFACE_GUARD, "", ...pieces].join("\n");

	const banner = [
		"/*",
		" * DO NOT EDIT THIS BLOCK.",
		" * Compiled from the platform source by the build script:",
		...modules.map((m) => ` *   ${m}`),
		` * Rebuild with: ${rebuildCommand}`,
		" */",
	].join("\n");

	return { engine, banner, block: `${banner}\n\n${engine}` };
}

/**
 * Substitutes the compiled block into a template at the `/*__ENGINE__*\/`
 * marker. Exits with a message if the marker has been removed, because a page
 * that silently ships without the engine would look fine and prove nothing.
 *
 * The replacement is passed as a function on purpose. Given a string,
 * `String.prototype.replace` reads `$&`, `$\'` and friends in it as
 * backreferences, and the compiled source contains `"\\$&"` in the keyword
 * escaper — which would be silently rewritten into the marker itself. A
 * function replacement is inserted verbatim.
 */
export function renderTemplate(templatePath, block) {
	const template = readFileSync(templatePath, "utf8");
	if (!template.includes("/*__ENGINE__*/")) {
		console.error(
			`${templatePath} no longer contains the /*__ENGINE__*/ marker.`,
		);
		process.exit(1);
	}
	const rendered = template.replace("/*__ENGINE__*/", () => block);
	if (rendered.includes("/*__ENGINE__*/")) {
		console.error(
			`${templatePath} still contains the /*__ENGINE__*/ marker after substitution.`,
		);
		process.exit(1);
	}
	return rendered;
}
