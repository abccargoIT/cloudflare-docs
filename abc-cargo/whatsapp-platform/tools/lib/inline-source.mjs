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

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSync } from "esbuild";

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
/**
 * Compiles `modules` (paths relative to `root`) into a single block of
 * JavaScript, prefixed with a banner naming its provenance.
 *
 * Bundled with esbuild rather than concatenated. The previous approach erased
 * the import and export keywords and ran every file into one scope, which
 * worked while there were eight modules and stopped working at twenty-six:
 * `auth/policy.ts`, `chat/policy.ts` and `broadcasts/policy.ts` each declare a
 * private `const ALLOW`, and three `const ALLOW` declarations in one scope is a
 * SyntaxError that takes the whole page down. Several other private helpers
 * collide the same way.
 *
 * A bundler gives each module its own scope and renames what it has to, so
 * adding a module can no longer break an unrelated one. The output is still
 * the platform's own compiled source with nothing re-implemented by hand.
 *
 * Everything the page uses is reached through one global, `ENGINE`, which the
 * entry point below exports. Anything not named there is not available to the
 * page — which is a feature: it makes the page's dependency on the platform
 * explicit rather than ambient.
 */
export function inlineModules(root, modules, rebuildCommand) {
	const dir = mkdtempSync(join(tmpdir(), "abc-engage-build-"));
	try {
		// An entry point that re-exports every module, so the bundle carries
		// everything the page might reach for and nothing is tree-shaken away.
		const entry = join(dir, "entry.ts");
		writeFileSync(
			entry,
			modules
				.map((m) => `export * from ${JSON.stringify(join(root, m))};`)
				.join("\n"),
			"utf8",
		);

		const result = buildSync({
			entryPoints: [entry],
			bundle: true,
			format: "iife",
			globalName: "ENGINE",
			platform: "browser",
			target: "es2022",
			write: false,
			legalComments: "none",
			// Given inline so esbuild does not walk up to the documentation
			// site's own tsconfig, which extends an Astro preset that is not
			// installed here and produces a warning on every build.
			tsconfigRaw: {
				compilerOptions: { target: "es2022", useDefineForClassFields: false },
			},
			// Readable rather than minified: the page is a demonstration and
			// somebody may well open it to check a rule for themselves.
			minify: false,
		});

		const engine = [
			INTERFACE_GUARD,
			"",
			result.outputFiles[0].text.trim(),
		].join("\n");

		const banner = [
			"/*",
			" * DO NOT EDIT THIS BLOCK.",
			" * Compiled and bundled from the platform source by the build script:",
			...modules.map((m) => ` *   ${m}`),
			` * Rebuild with: ${rebuildCommand}`,
			" *",
			" * Everything is reached through the ENGINE global.",
			" */",
		].join("\n");

		return { engine, banner, block: `${banner}\n\n${engine}` };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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
