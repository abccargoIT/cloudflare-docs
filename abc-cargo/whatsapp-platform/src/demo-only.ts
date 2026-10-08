/**
 * The demonstration, and nothing else.
 *
 * A separate entry point from `index.ts`, deployed with its own configuration,
 * because the approval given was for the demonstration and the safest way to
 * honour that is to deploy something that is incapable of anything more.
 *
 * What this Worker does not have: no D1 binding, no R2 bucket, no queues, no
 * Durable Object, no WhatsApp token, no webhook route, no API. There is no
 * configuration mistake, no stray route and no later edit to `index.ts` that
 * could make this reach a customer, because the parts that could are not
 * deployed with it.
 *
 * It serves one page and refuses everything else.
 */

import demoPage from "../demo/app.html";

/** Nothing here reads a binding, so the environment is deliberately empty. */
export interface DemoEnv {
	/** Optional label shown in logs, so a deployment can be identified. */
	DEPLOY_NOTE?: string;
}

const SECURITY_HEADERS: Record<string, string> = {
	"content-type": "text/html; charset=utf-8",
	// A rebuilt demonstration should reach a reviewer on the next refresh
	// rather than in an hour.
	"cache-control": "no-cache",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	// The page loads nothing from anywhere, so say so: a stray tag added later
	// fails loudly instead of quietly fetching.
	"content-security-policy":
		"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
	// It carries invented customer records under ABC Cargo's name. It has no
	// business in a search index.
	"x-robots-tag": "noindex, nofollow, noarchive",
};

export default {
	fetch(request: Request): Response {
		const url = new URL(request.url);

		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method not allowed", {
				status: 405,
				headers: { allow: "GET, HEAD", "x-robots-tag": "noindex" },
			});
		}

		if (url.pathname === "/health") {
			return new Response(JSON.stringify({ ok: true, mode: "demonstration" }), {
				headers: {
					"content-type": "application/json; charset=utf-8",
					"x-robots-tag": "noindex",
				},
			});
		}

		if (url.pathname === "/" || url.pathname === "/demo") {
			return new Response(request.method === "HEAD" ? null : demoPage, {
				headers: SECURITY_HEADERS,
			});
		}

		// Everything else, including anything that looks like the real API or
		// the Meta webhook, is simply not here.
		return new Response("Not found", {
			status: 404,
			headers: { "content-type": "text/plain", "x-robots-tag": "noindex" },
		});
	},
} satisfies ExportedHandler<DemoEnv>;
