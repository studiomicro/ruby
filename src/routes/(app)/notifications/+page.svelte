<script lang="ts">
	import { flip } from 'svelte/animate';
	import { flipParams, leave, rise } from '#lib/ui/motion';
	import { enhance } from '#lib/ui/pwa/offline-form';
	import { goto } from '$app/navigation';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import RelativeTime from '#lib/ui/comments/RelativeTime.svelte';

	let { data } = $props();

	const unreadOnly = $derived(data.filter === 'unread');
	const anyUnread = $derived(data.unread > 0);
	const filterHref = (filter: 'all' | 'unread') =>
		filter === 'unread' ? '/notifications?filter=unread' : '/notifications';
	const olderHref = $derived(
		data.next
			? `/notifications?${unreadOnly ? 'filter=unread&' : ''}before=${encodeURIComponent(data.next)}`
			: null
	);
	let busy = $state<string | null>(null);

	/**
	 * With JavaScript, following a row's link marks it read first (briefly awaited, so the badge on the next page is
	 * right), then navigates; a failed or slow request never blocks the link. Without JavaScript it is a plain link
	 * and the row's "Mark read" button does the marking.
	 */
	async function open(event: MouseEvent, id: string, href: string, unread: boolean) {
		if (!unread || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
		event.preventDefault();
		const body = new FormData();
		body.set('id', id);
		body.set('quiet', '1');
		await Promise.race([
			fetch('?/read', {
				method: 'POST',
				body,
				keepalive: true,
				headers: { 'x-sveltekit-action': 'true' }
			}).catch(() => null),
			new Promise((resolve) => setTimeout(resolve, 800))
		]);
		await goto(href, { invalidateAll: true });
	}
</script>

<PageHeader title="Notifications">
	{#snippet actions()}
		<Button href="/reminders" variant="ghost">My reminders</Button>
		{#if anyUnread}
			<form
				method="POST"
				action="?/readAll"
				use:enhance={() => {
					busy = 'all';
					return async ({ update }) => {
						await update();
						busy = null;
					};
				}}
			>
				<input type="hidden" name="filter" value={data.filter} />
				<Button type="submit" loading={busy === 'all'} loadingLabel="Marking…">Mark all read</Button
				>
			</form>
		{/if}
	{/snippet}
</PageHeader>

<nav class="filters" aria-label="Filter">
	<a href={filterHref('all')} aria-current={unreadOnly ? undefined : 'page'}>All</a>
	<a href={filterHref('unread')} aria-current={unreadOnly ? 'page' : undefined}>Unread</a>
</nav>

{#if data.items.length === 0}
	{#if unreadOnly}
		<EmptyState title="You’re all caught up" description="No unread notifications." />
	{:else if data.before}
		<EmptyState
			title="No older notifications"
			action={{ href: '/notifications', label: 'Back to newest' }}
		/>
	{:else}
		<EmptyState
			title="No notifications yet"
			description="Mentions, comments on your tasks, assignments and your reminders show up here."
		/>
	{/if}
{:else}
	<ul class="list">
		{#each data.items as n (n.id)}
			<!-- RB-20 Part B: a row added or removed after load slides in or fades out; the rest close up. -->
			<li
				class="row"
				class:unread={n.unread}
				in:rise|local
				out:leave|local={{ instant: true }}
				animate:flip={flipParams(data.items.length)}
			>
				<span class="dot" aria-hidden="true"></span>
				<div class="text">
					<p class="sentence">
						{#if n.unread}<span class="sr-only">Unread: </span>{/if}
						{#if n.kind === 'reminder'}
							<strong>Reminder:</strong>
							{#if n.href}
								<a href={n.href} onclick={(e) => open(e, n.id, n.href ?? '', n.unread)}
									>{n.summary ?? 'Reminder'}</a
								>
							{:else}
								{n.summary ?? 'Reminder'} <span class="gone">(no longer available)</span>
							{/if}
						{:else}
							<strong>{n.actorName}</strong>
							{n.verb}
						{/if}
						{#if n.kind === 'reminder'}{:else if n.href && n.targetTitle}
							<a href={n.href} onclick={(e) => open(e, n.id, n.href ?? '', n.unread)}
								>{n.targetTitle}</a
							>
						{:else}
							<span class="gone">This item is no longer available</span>
						{/if}
					</p>
					{#if n.excerpt}
						<p class="excerpt">{n.excerpt}</p>
					{:else if n.commentDeleted}
						<p class="excerpt gone">Comment deleted</p>
					{/if}
					<p class="when"><RelativeTime at={n.createdAt} /></p>
				</div>
				{#if n.unread}
					<form
						method="POST"
						action="?/read"
						use:enhance={() => {
							busy = n.id;
							return async ({ update }) => {
								await update();
								busy = null;
							};
						}}
					>
						<input type="hidden" name="id" value={n.id} />
						<input type="hidden" name="filter" value={data.filter} />
						{#if data.before}<input type="hidden" name="before" value={data.before} />{/if}
						<Button
							type="submit"
							size="sm"
							variant="ghost"
							loading={busy === n.id}
							loadingLabel="Marking…">Mark read</Button
						>
					</form>
				{/if}
			</li>
		{/each}
	</ul>
	{#if olderHref}
		<div class="more"><Button href={olderHref}>Load older</Button></div>
	{/if}
{/if}

<style>
	.filters {
		display: inline-flex;
		gap: 2px;
		margin-bottom: 14px;
		padding: 3px;
		border-radius: var(--radius-m);
		background: var(--surface-2);
	}
	.filters a {
		display: inline-flex;
		align-items: center;
		min-height: 30px;
		padding: 0 14px;
		border-radius: var(--radius-s);
		color: var(--muted);
		font-size: 13px;
		font-weight: 500;
		text-decoration: none;
	}
	@media (pointer: coarse) {
		.filters a {
			min-height: 44px;
		}
	}
	.filters a[aria-current='page'] {
		background: var(--surface);
		color: var(--fg);
		box-shadow: var(--shadow-1);
	}
	.list {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.row {
		display: grid;
		grid-template-columns: 10px minmax(0, 1fr) auto;
		align-items: start;
		gap: 10px;
		padding: 12px 12px 12px 14px;
	}
	.row + .row {
		border-top: 1px solid var(--border);
	}
	.dot {
		width: 8px;
		height: 8px;
		margin-top: 7px;
		border-radius: 50%;
	}
	.unread .dot {
		background: var(--accent);
	}
	.text {
		display: grid;
		gap: 4px;
		min-width: 0;
	}
	.sentence {
		margin: 0;
		font-size: 14px;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}
	.sentence a {
		color: var(--accent);
		font-weight: 500;
	}
	@media (pointer: coarse) {
		.sentence a {
			display: inline-block;
			padding: 10px 0;
			margin: -10px 0;
		}
	}
	.excerpt {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	.gone {
		color: var(--muted);
		font-style: italic;
	}
	.when {
		margin: 0;
		color: var(--muted);
		font-size: 12px;
	}
	.more {
		display: flex;
		justify-content: center;
		margin-top: 14px;
	}
</style>
