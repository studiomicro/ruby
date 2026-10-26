<!--
	LabelChip: a label as a small chip: a colour dot plus the name as plain text (colour is never the only signal).
	The eight colours are mid tones that read on light and dark surfaces alike. RB-12: a team label (`scope="team"`)
	carries a tag icon and "Team label" for screen readers, so it never looks like the project's own.
-->
<script lang="ts">
	import type { LabelColor } from '#lib/shared/enums';
	import Icon from '#lib/ui/kit/Icon.svelte';

	let {
		name,
		color,
		scope = 'project'
	}: { name: string; color: LabelColor; scope?: 'project' | 'team' } = $props();
</script>

<span class="chip" class:team={scope === 'team'}
	>{#if scope === 'team'}<span class="mark"><Icon name="tag" size={11} /></span><span
			class="sr-only"
			>Team label:
		</span>{/if}<span class="dot {color}" aria-hidden="true"></span><span class="name">{name}</span
	></span
>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		max-width: 100%;
		min-height: 20px;
		padding: 0 7px 0 6px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--fg);
		font-size: 12px;
		font-weight: 500;
		line-height: 1.2;
	}
	.mark {
		display: inline-flex;
		color: var(--muted);
	}
	.team {
		border-style: dashed;
		border-color: var(--border-strong);
	}
	.name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}
	.gray {
		background: #8d8d86;
	}
	.red {
		background: #e5484d;
	}
	.orange {
		background: #f76b15;
	}
	.yellow {
		background: #d6a600;
	}
	.green {
		background: #30a46c;
	}
	.blue {
		background: #3e7bfa;
	}
	.purple {
		background: #8e4ec6;
	}
	.pink {
		background: #d6409f;
	}
</style>
