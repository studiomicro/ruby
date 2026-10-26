<!--
	CommentForm: the Markdown textarea of a new comment or an edit, with Write | Preview tabs, a character counter
	and the @mention picker. Posts to the host page's `?/<action>` (works without JavaScript: a plain POST and
	redirect; the picker and the tabs need JavaScript, typed mention tokens still post). With JavaScript the submit
	button disables while the request runs, the text stays on a refusal and clears only after the server confirmed
	the comment (the redirect).

	The picker: typing `@` and a few letters lists matching active users from /api/mentions (debounced, stale
	requests aborted). Arrow keys move, Enter or Tab inserts `@[Name](user:<id>)` and a space, Escape closes. The
	textarea points at the active option (`aria-activedescendant`); the list is an ARIA listbox.
-->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { enhance } from '#lib/ui/pwa/offline-form';
	import { COMMENT_BODY_MAX } from '#lib/shared/comments';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Markdown from '#lib/ui/kit/Markdown.svelte';
	import { insertMention, mentionQueryAt } from './mention';

	const uid = $props.id();
	let {
		action,
		label,
		submitLabel,
		initial = '',
		error = null,
		hidden = {},
		cancelHref,
		rows = 4
	}: {
		action: 'commentCreate' | 'commentEdit';
		label: string;
		submitLabel: string;
		initial?: string;
		error?: string | null;
		/** Extra fields the action reads (comment id, version, thread page). */
		hidden?: Record<string, string>;
		cancelHref?: string;
		rows?: number;
	} = $props();

	// The form owns its text from here on (a refusal re-renders it with what was typed).
	// svelte-ignore state_referenced_locally
	let text = $state(initial);
	let textarea = $state<HTMLTextAreaElement>();
	let mounted = $state(false);
	let preview = $state(false);
	let saving = $state(false);
	onMount(() => (mounted = true));

	const count = $derived(Array.from(text).length);
	const over = $derived(count > COMMENT_BODY_MAX);

	// ── Mention picker ────────────────────────────────────────────────────────────────────────────────────
	type Person = { id: string; name: string };
	const listId = `${uid}-mentions`;
	let options = $state<Person[]>([]);
	let active = $state(0);
	let open = $state(false);
	let mention: { start: number; query: string } | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;

	function close() {
		open = false;
		options = [];
		mention = null;
		clearTimeout(timer);
		controller?.abort();
	}

	async function search(query: string) {
		controller?.abort();
		const mine = new AbortController();
		controller = mine;
		try {
			const response = await fetch(`/api/mentions?q=${encodeURIComponent(query)}`, {
				signal: mine.signal,
				headers: { accept: 'application/json' }
			});
			if (!response.ok || controller !== mine) return;
			const data = (await response.json()) as { users?: Person[] };
			if (controller !== mine || !mention) return;
			options = Array.isArray(data.users) ? data.users : [];
			active = 0;
			open = options.length > 0;
		} catch {
			// Aborted by a newer keystroke, or offline: the picker just stays closed.
		}
	}

	function refresh() {
		const el = textarea;
		if (!el || el.selectionStart !== el.selectionEnd) return close();
		const found = mentionQueryAt(text, el.selectionStart);
		if (!found) return close();
		mention = found;
		clearTimeout(timer);
		timer = setTimeout(() => search(found.query), 150);
	}

	async function choose(person: Person | undefined) {
		const el = textarea;
		if (!person || !el || !mention) return;
		const next = insertMention(text, mention.start, el.selectionStart, person);
		text = next.text;
		close();
		await tick();
		el.focus();
		el.setSelectionRange(next.caret, next.caret);
	}

	function onkeydown(event: KeyboardEvent) {
		if (!open || options.length === 0) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			active = (active + step + options.length) % options.length;
		} else if (event.key === 'Enter' || event.key === 'Tab') {
			event.preventDefault();
			void choose(options[active]);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			close();
		}
	}
</script>

<form
	method="POST"
	action="?/{action}"
	class="comment-form"
	use:enhance={({ cancel }) => {
		if (over) return cancel();
		saving = true;
		close();
		return async ({ result, update }) => {
			if (result.type === 'redirect') text = '';
			await update({ reset: false });
			saving = false;
		};
	}}
>
	{#each Object.entries(hidden) as [name, value] (name)}
		<input type="hidden" {name} {value} />
	{/each}

	<div class="head">
		<label for="{uid}-body">{label}</label>
		{#if mounted}
			<div class="tabs" role="group" aria-label="{label} mode">
				<button type="button" aria-pressed={!preview} onclick={() => (preview = false)}
					>Write</button
				>
				<button type="button" aria-pressed={preview} onclick={() => ((preview = true), close())}
					>Preview</button
				>
			</div>
		{/if}
	</div>

	<div class="write" class:hidden={preview}>
		<textarea
			bind:this={textarea}
			bind:value={text}
			id="{uid}-body"
			name="body"
			{rows}
			required
			aria-invalid={error || over ? true : undefined}
			aria-describedby="{uid}-count{error ? ` ${uid}-error` : ''}"
			aria-autocomplete="list"
			aria-controls={listId}
			aria-activedescendant={open ? `${listId}-${active}` : undefined}
			oninput={refresh}
			onclick={refresh}
			{onkeydown}
			onkeyup={(event) => {
				if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') refresh();
			}}
			onblur={() => setTimeout(close, 150)}></textarea>
		<ul id={listId} class="listbox" role="listbox" aria-label="People to mention" hidden={!open}>
			{#each options as person, i (person.id)}
				<li
					id="{listId}-{i}"
					role="option"
					tabindex="-1"
					aria-selected={i === active}
					onpointerdown={(event) => event.preventDefault()}
					onclick={() => choose(person)}
					onkeydown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							void choose(person);
						}
					}}
				>
					{person.name}
				</li>
			{/each}
		</ul>
		<p class="sr-only" aria-live="polite">
			{open ? `${options.length} ${options.length === 1 ? 'person' : 'people'} found.` : ''}
		</p>
	</div>

	{#if preview}
		<div class="preview" aria-live="polite">
			<Markdown source={text} empty="Nothing to preview." />
		</div>
	{/if}

	<div class="foot">
		<p id="{uid}-count" class="count" class:over>
			{count.toLocaleString('en-US')} / {COMMENT_BODY_MAX.toLocaleString('en-US')}
			<span class="hint">· Markdown, @ to mention</span>
		</p>
		<div class="actions">
			{#if cancelHref}<Button href={cancelHref} variant="ghost">Cancel</Button>{/if}
			<Button
				type="submit"
				variant="primary"
				loading={saving}
				disabled={over}
				loadingLabel="Saving…">{submitLabel}</Button
			>
		</div>
	</div>
	<div id="{uid}-error"><Banner tone="error" message={error} /></div>
</form>

<style>
	.comment-form {
		display: grid;
		gap: 8px;
		min-width: 0;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	label {
		font-size: 13px;
		font-weight: 500;
	}
	.tabs {
		display: inline-flex;
		padding: 3px;
		border-radius: var(--radius-m);
		background: var(--surface-2);
	}
	.tabs button {
		min-height: 30px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-s);
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		.tabs button {
			min-height: 44px;
		}
	}
	.tabs button[aria-pressed='true'] {
		background: var(--surface);
		color: var(--fg);
		box-shadow: var(--shadow-1);
	}
	.write {
		position: relative;
		min-width: 0;
	}
	.hidden {
		display: none;
	}
	textarea {
		display: block;
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
		padding: 8px 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-m);
		background: var(--surface);
		color: var(--fg);
		font: inherit;
		/* iOS zooms into a field under 16 px (app.css). */
		font-size: max(16px, 1em);
		line-height: 1.5;
		resize: vertical;
	}
	textarea:focus {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	textarea[aria-invalid='true'] {
		border-color: var(--danger);
	}
	.listbox {
		position: absolute;
		z-index: 15;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		max-width: 360px;
		max-height: 240px;
		margin: 0;
		padding: 4px;
		overflow-y: auto;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		background: var(--surface);
		box-shadow: var(--shadow-2);
	}
	.listbox[hidden] {
		display: none;
	}
	.listbox li {
		display: flex;
		align-items: center;
		min-height: 36px;
		padding: 0 10px;
		border-radius: var(--radius-s);
		font-size: 14px;
		cursor: pointer;
		overflow-wrap: anywhere;
	}
	@media (pointer: coarse) {
		.listbox li {
			min-height: 44px;
		}
	}
	.listbox li[aria-selected='true'] {
		background: var(--accent-soft);
		color: var(--accent);
	}
	.preview {
		min-height: 96px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		background: var(--surface);
		overflow-wrap: anywhere;
	}
	.foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.count {
		margin: 0;
		color: var(--muted);
		font-size: 12px;
	}
	.count.over {
		color: var(--danger);
		font-weight: 600;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-left: auto;
	}
</style>
