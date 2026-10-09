/**
 * HTML files are bundled as text modules by the "rules" entry in
 * wrangler.jsonc, so the Worker can serve the built demonstration page
 * without a second host.
 */
declare module "*.html" {
	const content: string;
	export default content;
}
