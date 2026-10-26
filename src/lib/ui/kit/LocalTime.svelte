<!--
	LocalTime: a stored UTC-millisecond timestamp shown in the viewer's own time zone and locale (CLAUDE.md: format
	in the browser only). The server renders the UTC date (`2026-10-26`) inside <time datetime>; after hydration it
	becomes the local form. `withTime` adds hours and minutes. Null shows `fallback`.
-->
<script lang="ts">
	import { onMount } from 'svelte';

	let {
		at,
		withTime = false,
		fallback = '—'
	}: { at: number | null | undefined; withTime?: boolean; fallback?: string } = $props();

	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	const iso = $derived(at == null ? '' : new Date(at).toISOString());
	const text = $derived.by(() => {
		if (at == null) return fallback;
		if (!mounted)
			return iso.slice(0, withTime ? 16 : 10).replace('T', ' ') + (withTime ? ' UTC' : '');
		return new Date(at).toLocaleString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			...(withTime ? { hour: '2-digit', minute: '2-digit' } : {})
		});
	});
</script>

{#if at == null}{fallback}{:else}<time datetime={iso}>{text}</time>{/if}
