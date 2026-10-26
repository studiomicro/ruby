<!--
	RelativeTime: a stored UTC-millisecond moment as "5 min ago" once the page runs in the browser (the server renders
	the UTC date and time, as LocalTime does), with the full local date and time in `title`. Older than 30 days it
	shows the local date.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { relativeTime } from './relative';

	let { at }: { at: number } = $props();

	let clock = $state<number | null>(null);
	onMount(() => {
		clock = Date.now();
		const timer = setInterval(() => (clock = Date.now()), 60_000);
		return () => clearInterval(timer);
	});

	const iso = $derived(new Date(at).toISOString());
	const absolute = $derived(
		clock === null
			? `${iso.slice(0, 16).replace('T', ' ')} UTC`
			: new Date(at).toLocaleString(undefined, {
					year: 'numeric',
					month: 'short',
					day: 'numeric',
					hour: '2-digit',
					minute: '2-digit'
				})
	);
	const text = $derived(
		clock === null
			? absolute
			: (relativeTime(at, clock) ??
					new Date(at).toLocaleDateString(undefined, {
						year: 'numeric',
						month: 'short',
						day: 'numeric'
					}))
	);
</script>

<time datetime={iso} title={absolute}>{text}</time>
