<!--
	Toaster: the stack of toasts from `showToast` (./toast.svelte.ts), in Kumo's look: a raised card with a title in the
	tone's colour, optional text and a close button. Rendered once, by the app shell. The region is a polite live
	region that exists from the first paint, so screen readers hear each new toast; an error toast is role="alert".
	It sits above the phone tab bar and the home indicator, and bottom right from 768 px.
-->
<script lang="ts">
	import { flip } from 'svelte/animate';
	import { flipParams, leave } from '#lib/ui/motion';
	import Icon from './Icon.svelte';
	import { dismissToast, toasts } from './toast.svelte';
</script>

<section class="toaster" aria-label="Messages" aria-live="polite">
	{#each toasts as toast (toast.id)}
		<!-- RB-20 Part B: a toast rises in (CSS), fades out when it leaves, and the stack closes up (FLIP). -->
		<div
			class="toast {toast.tone}"
			role={toast.tone === 'error' ? 'alert' : 'status'}
			out:leave|local
			animate:flip={flipParams(toasts.length)}
		>
			<div class="text">
				<p class="title">{toast.title}</p>
				{#if toast.description}<p class="description">{toast.description}</p>{/if}
			</div>
			<button
				type="button"
				class="close"
				aria-label="Dismiss"
				onclick={() => dismissToast(toast.id)}
			>
				<Icon name="close" size={14} />
			</button>
		</div>
	{/each}
</section>

<style>
	.toaster {
		position: fixed;
		z-index: 45;
		left: max(8px, var(--sai-left));
		right: max(8px, var(--sai-right));
		bottom: calc(var(--tabbar-h) + var(--sai-bottom) + 8px);
		display: grid;
		gap: 8px;
		justify-items: stretch;
		pointer-events: none;
	}
	@media (min-width: 768px) {
		.toaster {
			left: auto;
			right: max(16px, var(--sai-right));
			bottom: calc(16px + var(--sai-bottom));
			width: 360px;
		}
	}
	.toast {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 12px 8px 12px 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface);
		box-shadow: var(--shadow-2);
		pointer-events: auto;
		animation: rise var(--dur) var(--ease-out);
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}
	/* Under reduced motion a toast only fades in. */
	@media (prefers-reduced-motion: reduce) {
		.toast {
			animation: toast-fade var(--dur-fast) var(--ease);
		}
		@keyframes toast-fade {
			from {
				opacity: 0;
			}
		}
	}
	.text {
		flex: 1;
		min-width: 0;
	}
	.title {
		margin: 0;
		color: var(--fg);
		font-size: var(--text-base);
		font-weight: 500;
		line-height: 1.4;
	}
	.success .title {
		color: var(--success);
	}
	.error .title {
		color: var(--danger);
	}
	.warning .title {
		color: var(--warning);
	}
	.info .title {
		color: var(--accent);
	}
	.description {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}
	.close {
		display: grid;
		place-items: center;
		flex: none;
		width: 24px;
		height: 24px;
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
			margin: -10px 0 -10px 0;
		}
	}
</style>
