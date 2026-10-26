import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
	{
		ignores: [
			'.claude/',
			'.svelte-kit/',
			'**/.wrangler/',
			'build/',
			'docs/',
			'migrations/',
			'test-results/',
			'playwright-report/',
			'e2e/.auth/',
			'**/worker-configuration.d.ts'
		]
	},
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			'no-undef': 'off',
			// Ruby sets no `paths.base`, so `resolve()` from $app/paths would return every href unchanged; links to
			// pages other features add (/projects, /kb …) would also fail its typed route check until they exist.
			'svelte/no-navigation-without-resolve': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: { parserOptions: { parser: ts.parser } }
	}
);
