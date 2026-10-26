<!--
	Dialog: a modal on the native <dialog> and showModal(), so focus moves in and stays in, Escape closes it and the
	page behind is inert (Kumo Dialog). `open` is bindable. Escape, the close button or a click on the backdrop closes
	it, sets `open` false and calls `onclose`; focus then returns to the element that had it before. `title` labels the
	dialog and `description` describes it. `sheet` makes it a bottom sheet below 768 px, clear of the home indicator
	(--sai-bottom). Buttons go in `actions`; a form inside can use method="dialog" to close. Needs JavaScript, so keep
	a no-JS route to anything essential.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	const uid = $props.id();
	let {
		open = $bindable(false),
		title,
		description,
		sheet = false,
		size = 'md',
		onclose,
		children,
		actions
	}: {
		open?: boolean;
		title: string;
		description?: string;
		sheet?: boolean;
		size?: 'sm' | 'md' | 'lg';
		onclose?: () => void;
		children?: Snippet;
		actions?: Snippet;
	} = $props();

	let dialog = $state<HTMLDialogElement>();
	let opener: Element | null = null;

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			opener = document.activeElement;
			dialog.showModal();
		} else if (!open && dialog.open) {
			dialog.close();
		}
	});

	function closed() {
		open = false;
		onclose?.();
		if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
		opener = null;
	}
</script>

<!-- The click only catches the backdrop; Escape is the keyboard way out (native <dialog>). -->
<dialog
	bind:this={dialog}
	class="dialog {size}"
	class:sheet
	aria-labelledby="{uid}-title"
	aria-describedby={description ? `${uid}-description` : undefined}
	onclose={closed}
	onclick={(event) => {
		if (event.target === dialog) dialog?.close();
	}}
>
	<div class="panel">
		<header class="head">
			<h2 id="{uid}-title" class="title">{title}</h2>
			<button type="button" class="close" aria-label="Close" onclick={() => dialog?.close()}>
				<Icon name="close" size={16} />
			</button>
		</header>
		{#if description}<p id="{uid}-description" class="description">{description}</p>{/if}
		{#if children}<div class="body">{@render children()}</div>{/if}
		{#if actions}<footer class="actions">{@render actions()}</footer>{/if}
	</div>
</dialog>

<style>
	.dialog {
		box-sizing: border-box;
		width: calc(100% - 32px);
		max-height: calc(100dvh - 32px - var(--sai-top) - var(--sai-bottom));
		margin: calc(48px + var(--sai-top)) auto auto;
		padding: 0;
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface);
		box-shadow: var(--shadow-2);
		color: var(--fg);
		/* Closed: faded and slightly smaller; open: in place. The change between them is the motion below. */
		opacity: 0;
		transform: scale(0.96);
	}
	.dialog[open] {
		opacity: 1;
		transform: none;
	}
	.sm {
		max-width: 400px;
	}
	.md {
		max-width: 520px;
	}
	.lg {
		max-width: 720px;
	}
	@starting-style {
		.dialog[open] {
			opacity: 0;
			transform: scale(0.96);
		}
	}
	/*
	 * RB-20 Part B motion: on desktop the dialog fades and scales from 0.96 (`--dur`); below 768 px it rises from the
	 * bottom (`--dur-slow`), a sheet from the bottom edge. Closing mirrors opening (`allow-discrete` keeps it on screen
	 * until the fade ends). Under reduced motion it only fades, in `--dur-fast`.
	 */
	@media (prefers-reduced-motion: no-preference) {
		.dialog {
			transition:
				opacity var(--dur) var(--ease-out),
				transform var(--dur) var(--ease-out),
				overlay var(--dur) allow-discrete,
				display var(--dur) allow-discrete;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.dialog,
		.dialog[open] {
			transform: none;
			transition:
				opacity var(--dur-fast) var(--ease),
				overlay var(--dur-fast) allow-discrete,
				display var(--dur-fast) allow-discrete;
		}
		@starting-style {
			.dialog[open] {
				transform: none;
			}
		}
	}
	/* Kumo's backdrop: the recessed surface at 80 %, not a dark scrim. */
	.dialog::backdrop {
		background: var(--backdrop, rgb(242 242 242 / 0.8));
	}
	.panel {
		display: grid;
		gap: 12px;
		padding: 20px;
	}
	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}
	.title {
		margin: 0;
		color: var(--fg-strong);
		font-size: var(--text-lg);
		font-weight: 600;
		line-height: 1.4;
	}
	.close {
		display: grid;
		place-items: center;
		flex: none;
		width: 28px;
		height: 28px;
		margin: -4px -6px 0 0;
		border: 0;
		border-radius: var(--radius-s);
		background: none;
		color: var(--muted);
		cursor: pointer;
	}
	.close:hover {
		background: var(--surface-2);
		color: var(--fg);
	}
	@media (pointer: coarse) {
		.close {
			width: 44px;
			height: 44px;
			margin: -12px -12px 0 0;
		}
	}
	.description {
		margin: -6px 0 0;
		color: var(--muted);
		font-size: var(--text-base);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
		padding-top: 4px;
	}
	/* Below 768 px a sheet rises from the bottom edge, over the tab bar, clear of the home indicator. */
	@media (max-width: 767px) {
		.sheet {
			width: 100%;
			max-width: none;
			max-height: calc(100dvh - var(--sai-top) - 24px);
			margin: auto 0 0;
			border-width: 1px 0 0;
			border-radius: var(--radius-xl) var(--radius-xl) 0 0;
		}
		.sheet .panel {
			padding: 16px max(16px, var(--sai-right)) calc(16px + var(--sai-bottom))
				max(16px, var(--sai-left));
		}
	}
	@media (max-width: 767px) and (prefers-reduced-motion: no-preference) {
		.dialog {
			transform: translateY(16px);
			transition:
				opacity var(--dur-slow) var(--ease-out),
				transform var(--dur-slow) var(--ease-out),
				overlay var(--dur-slow) allow-discrete,
				display var(--dur-slow) allow-discrete;
		}
		.sheet {
			transform: translateY(100%);
		}
		.dialog[open] {
			transform: none;
		}
		@starting-style {
			.dialog[open] {
				transform: translateY(16px);
			}
			.sheet[open] {
				transform: translateY(100%);
			}
		}
	}
</style>
