import pluginJavaScript from "@eslint/js";
import pluginTypeScript from "typescript-eslint";

export default [
	pluginJavaScript.configs.recommended,
	...pluginTypeScript.configs.recommended,
	{
		ignores: ["node_modules/", ".wrangler/", "worker-configuration.d.ts"],
	},
	{
		rules: {
			"no-var": "error",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
];
