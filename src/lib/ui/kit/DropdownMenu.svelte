<!--
	DropdownMenu: a button that opens a short menu of actions (Kumo Dropdown), after the WAI-ARIA menu-button
	pattern. Enter, Space or ArrowDown opens it on the first item (ArrowUp on the last); the arrow keys, Home and End
	move; Escape closes it and returns focus to the button; Tab or a click outside closes it. An item is a link
	(`href`), a callback (`onselect`) or a POST form (`action`, for a mutation such as signing out); `danger` marks a
	destructive one. `align` puts the menu under the button's start or end edge. `icon` with `hideLabel` makes an
	icon-only button named by `label`. Needs JavaScript: never make it the only way to reach something.
-->
<script lang="ts" module>
	export interface MenuItem {
		label: string;
		href?: string;
		/** A form action URL: the item is a submit button of a POST form. */
		action?: string;
		onselect?: () => void;
		danger?: boolean;
	}
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import Icon, { type IconName } from './Icon.svelte';

	const uid = $props.id();
	let {
		label,
		items,
		align = 'start',
		variant = 'secondary',
		icon,
		hideLabel = false
	}: {
		label: string;
		items: readonly MenuItem[];
		align?: 'start' | 'end';
		variant?: 'secondary' | 'ghost';
		icon?: IconName;
		hideLabel?: boolean;
	} = $props();

	let open = $state(false);
	let root = $state<HTMLElement>();
	let trigger = $state<HTMLButtonElement>();
	let menu = $state<HTMLElement>();

	const entries = () => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

	async function show(focus: 'first' | 'last') {
		open = true;
		await tick();
		const all = entries();
		(focus === 'first' ? all[0] : all.at(-1))?.focus();
	}
	function hide(returnFocus: boolean) {
		open = false;
		if (returnFocus) trigger?.focus();
	}

	function onTriggerKey(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			void show(event.key === 'ArrowDown' ? 'first' : 'last');
		}
	}
	function onMenuKey(event: KeyboardEvent) {
		const all = entries();
		const index = all.indexOf(document.activeElement as HTMLElement);
		let next = -1;
		if (event.key === 'ArrowDown') next = (index + 1) % all.length;
		else if (event.key === 'ArrowUp') next = (index - 1 + all.length) % all.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = all.length - 1;
		else if (event.key === 'Escape') {
			event.preventDefault();
			hide(true);
			return;
		} else if (event.key === 'Tab') {
			hide(false);
			return;
		}
		if (next < 0) return;
		event.preventDefault();
		all[next]?.focus();
	}
	function select(item: MenuItem) {
		item.onselect?.();
		hide(!item.href && !item.action);
	}
</script>

<svelte:document
	onpointerdown={(event) => {
		if (open && root && !root.contains(event.target as Node)) hide(false);
	}}
/>

<div class="dropdown" bind:this={root}>
	<button
		type="button"
		class="trigger {variant}"
		class:icon-only={icon && hideLabel}
		bind:this={trigger}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-controls="{uid}-menu"
		aria-label={hideLabel ? label : undefined}
		onclick={() => (open ? hide(false) : show('first'))}
		onkeydown={onTriggerKey}
	>
		{#if icon}<Icon name={icon} size={16} />{/if}
		{#if !hideLabel}<span>{label}</span><span class="caret" aria-hidden="true"></span>{/if}
	</button>
	<div
		id="{uid}-menu"
		class="menu {align}"
		role="menu"
		aria-label={label}
		tabindex="-1"
		hidden={!open}
		bind:this={menu}
		onkeydown={onMenuKey}
	>
		{#each items as item, index (index)}
			{#if item.href}
				<a
					role="menuitem"
					tabindex="-1"
					href={item.href}
					class="item"
					class:danger={item.danger}
					onclick={() => select(item)}>{item.label}</a
				>
			{:else if item.action}
				<form method="POST" action={item.action}>
					<button
						role="menuitem"
						tabindex="-1"
						type="submit"
						class="item"
						class:danger={item.danger}
						onclick={() => select(item)}>{item.label}</button
					>
				</form>
			{:else}
				<button
					role="menuitem"
					tabindex="-1"
					type="button"
					class="item"
					class:danger={item.danger}
					onclick={() => select(item)}>{item.label}</button
				>
			{/if}
		{/each}
	</div>
</div>

<style>
	.dropdown {
		position: relative;
		display: inline-block;
	}
	.trigger {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 36px;
		padding: 0 10px 0 12px;
		box-sizing: border-box;
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		background: var(--surface);
		box-shadow: var(--shadow-1);
		color: var(--fg);
		font: inherit;
		font-size: var(--text-base);
		font-weight: 500;
		cursor: pointer;
		transition: background-color var(--dur-fast) var(--ease);
	}
	.trigger.ghost {
		border-color: transparent;
		background: transparent;
		box-shadow: none;
	}
	.trigger:hover,
	.trigger[aria-expanded='true'] {
		background: var(--surface-2);
	}
	.trigger.icon-only {
		justify-content: center;
		width: 36px;
		padding: 0;
	}
	@media (pointer: coarse) {
		.trigger {
			min-height: 44px;
		}
		.trigger.icon-only {
			width: 44px;
		}
	}
	.caret {
		width: 5px;
		height: 5px;
		margin: -3px 2px 0 2px;
		border-right: 1.5px solid var(--muted);
		border-bottom: 1.5px solid var(--muted);
		transform: rotate(45deg);
	}
	/* Kumo's menu: control background, 1 px line, large shadow, 8 px radius, 6 px item radius. */
	.menu {
		position: absolute;
		z-index: 40;
		top: calc(100% + 4px);
		display: grid;
		min-width: 180px;
		max-width: min(320px, calc(100vw - 32px));
		padding: 4px;
		box-sizing: border-box;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--control);
		box-shadow: var(--shadow-2);
	}
	.menu[hidden] {
		display: none;
	}
	.menu.start {
		left: 0;
	}
	.menu.end {
		right: 0;
	}
	.menu:focus {
		outline: none;
	}
	form {
		display: contents;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 8px;
		box-sizing: border-box;
		width: 100%;
		min-height: 32px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--radius-s);
		background: none;
		color: var(--fg);
		font: inherit;
		font-size: var(--text-base);
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		.item {
			min-height: 44px;
		}
	}
	.item:hover,
	.item:focus {
		background: var(--surface-2);
		outline: none;
	}
	.item:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: -2px;
	}
	.item.danger {
		color: var(--danger);
	}
	.item.danger:hover,
	.item.danger:focus {
		background: var(--danger-soft);
	}
</style>
