import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every file under `dir` (recursively) whose name ends with one of `exts`. */
function files(dir: string, exts: string[]): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...files(path, exts));
		else if (exts.some((e) => name.endsWith(e))) out.push(path);
	}
	return out;
}

describe('safe areas (iPhone Dynamic Island, home indicator, landscape)', () => {
	const css = readFileSync('src/app.css', 'utf8');

	it('app.css defines the four --sai-* variables from env(safe-area-inset-*)', () => {
		for (const side of ['top', 'right', 'bottom', 'left'])
			expect(css).toMatch(new RegExp(`--sai-${side}:\\s*env\\(safe-area-inset-${side},\\s*0px\\)`));
	});

	it('no other file reads env(safe-area-inset-*) itself', () => {
		const offenders = files('src', ['.svelte', '.css', '.ts', '.html'])
			.filter((f) => f !== join('src', 'app.css') && !f.endsWith('worker-configuration.d.ts'))
			.filter((f) => readFileSync(f, 'utf8').includes('env(safe-area-inset'));
		expect(offenders).toEqual([]);
		// app.css itself reads each inset exactly once, in the :root block.
		expect(css.replace(/\/\*[\s\S]*?\*\//g, '').match(/env\(safe-area-inset-/g)).toHaveLength(4);
	});

	it('the viewport allows drawing under the safe areas and never blocks zoom', () => {
		const html = readFileSync('src/app.html', 'utf8');
		expect(html).toMatch(
			/name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/
		);
		const viewport = html.match(/<meta name="viewport" content="([^"]*)"/)?.[1] ?? '';
		expect(viewport).not.toMatch(/maximum-scale|user-scalable/);
	});

	it('uses dynamic viewport units, never 100vh', () => {
		const offenders = files('src', ['.svelte', '.css']).filter((f) =>
			/100vh/.test(readFileSync(f, 'utf8'))
		);
		expect(offenders).toEqual([]);
	});
});
