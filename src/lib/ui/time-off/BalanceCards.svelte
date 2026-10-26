<!-- BalanceCards: one card per balance-type leave: Entitled, Used, Pending and Available, in days. -->
<script lang="ts">
	import { formatDays } from '#lib/shared/time-off';

	let {
		balances,
		period
	}: {
		balances: readonly {
			typeId: string;
			typeName: string;
			entitled: number;
			used: number;
			pending: number;
			available: number;
		}[];
		period: number;
	} = $props();
</script>

<div class="cards">
	{#each balances as b (b.typeId)}
		<section class="card" aria-label="{b.typeName} {period}">
			<h3>{b.typeName} {period}</h3>
			<p class="available"><strong>{formatDays(b.available)}</strong> days available</p>
			<dl>
				<div>
					<dt>Entitled</dt>
					<dd>{formatDays(b.entitled)}</dd>
				</div>
				<div>
					<dt>Used</dt>
					<dd>{formatDays(b.used)}</dd>
				</div>
				<div>
					<dt>Pending</dt>
					<dd>{formatDays(b.pending)}</dd>
				</div>
			</dl>
		</section>
	{/each}
</div>

<style>
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
		gap: 10px;
	}
	.card {
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	h3 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
	}
	.available {
		margin: 4px 0 8px;
		font-size: 14px;
	}
	.available strong {
		font-size: 22px;
	}
	dl {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
		margin: 0;
	}
	dt {
		color: var(--muted);
		font-size: 12px;
	}
	dd {
		margin: 0;
		font-size: 14px;
		font-weight: 500;
	}
</style>
