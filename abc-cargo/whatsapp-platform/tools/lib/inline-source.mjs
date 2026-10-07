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
	const engine = pieces.join("\n");

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
