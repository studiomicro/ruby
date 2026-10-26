<script lang="ts">
	import { onMount } from 'svelte';
	import { RELEASES } from '#lib/content/releases';
	import { releaseAnchor } from '#lib/shared/releases';
	import Markdown from '#lib/ui/kit/Markdown.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import { markReleasesSeen } from '#lib/ui/shell/release-seen.svelte';

	onMount(markReleasesSeen);

	const dateFormat = new Intl.DateTimeFormat('en-GB', {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	});
	const formatDate = (iso: string) => dateFormat.format(new Date(`${iso}T00:00:00Z`));
</script>

<PageHeader title="What's new" description="What changed in each version of Ruby, newest first." />

{#if RELEASES.length > 0}
	<ol class="releases">
		{#each RELEASES as release, i (release.version)}
			<li>
				<article class="release" aria-labelledby={releaseAnchor(release.version)}>
					<h2 id={releaseAnchor(release.version)}>
						<a href="#{releaseAnchor(release.version)}">Version {release.version}</a>
						{#if i === 0}<span class="current">Current</span>{/if}
					</h2>
					<p class="meta">{release.title} · {formatDate(release.date)}</p>
					<Markdown source={release.body} />
				</article>
			</li>
		{/each}
	</ol>
{:else}
	<p class="meta">No release notes yet.</p>
{/if}

<style>
	.releases {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 16px;
		max-width: 760px;
	}
	.release {
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
		scroll-margin-top: calc(var(--topbar-h) + var(--sai-top) + 8px);
	}
	h2 {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin: 0;
		font-size: 18px;
	}
	h2 a {
		color: var(--fg);
		text-decoration: none;
	}
	.current {
		padding: 0 8px;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent);
		font-size: 12px;
		font-weight: 600;
		line-height: 20px;
	}
	.meta {
		margin: 4px 0 12px;
		color: var(--muted);
		font-size: 14px;
	}
</style>
