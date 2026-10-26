<script lang="ts">
	let { children } = $props();
</script>

<!-- Sign-in, setup and invite acceptance: no navigation, one narrow column. -->
<div class="auth">
	<div class="column">
		<p class="brand"><span class="mark" aria-hidden="true"></span>Ruby</p>
		<main class="card">
			{@render children()}
		</main>
	</div>
</div>

<style>
	/* Kumo's look for the signed-out pages: the canvas, Ruby's mark, one raised card (8 px radius, line, xs shadow). */
	.auth {
		display: grid;
		justify-items: center;
		align-content: start;
		min-height: 100dvh;
		box-sizing: border-box;
		padding: calc(48px + var(--sai-top)) max(16px, var(--sai-right)) calc(32px + var(--sai-bottom))
			max(16px, var(--sai-left));
		background: var(--bg);
	}
	@media (min-width: 768px) {
		.auth {
			padding-top: calc(12dvh + var(--sai-top));
		}
	}
	.column {
		width: 100%;
		max-width: 380px;
	}
	.brand {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		margin: 0 0 24px;
		color: var(--fg-strong);
		font-size: var(--text-xl);
		font-weight: 600;
		letter-spacing: -0.02em;
	}
	.mark {
		width: 18px;
		height: 18px;
		border-radius: 5px;
		background: var(--logo);
		box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.12);
	}
	.card {
		padding: 24px;
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface);
		box-shadow: var(--shadow-1);
	}
	/* The pages' own headings and lead text, in the kit's sizes. */
	.card :global(h1) {
		color: var(--fg-strong);
		letter-spacing: -0.02em;
	}
	@media (max-width: 420px) {
		.card {
			padding: 20px 16px;
		}
	}
</style>
