<!--
	CommentThread: the comments of a task or page, oldest first (100 per page, `?cpage=`), and the form for a new one.
	`thread` is the host loader's `comments` (loadThread). Bodies render only through the kit Markdown component with
	`thread.names`, so a mention shows its user's current name. Edit opens the author's own comment in place
	(`?cedit=<id>`, a link, so it works without JavaScript); Delete asks first when JavaScript runs. A refusal of a
	comment action comes back as `page.form.comment` and is shown next to the form it belongs to, with the typed text.
-->
<script lang="ts">
	import { flip } from 'svelte/animate';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { flipParams, leave, markSaved, rise } from '#lib/ui/motion';
	import { enhance } from '#lib/ui/pwa/offline-form';
	import type { CommentFormResult, ThreadData } from '#lib/shared/comments';
	import Avatar from '#lib/ui/kit/Avatar.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Markdown from '#lib/ui/kit/Markdown.svelte';
	import CommentForm from './CommentForm.svelte';
	import RelativeTime from './RelativeTime.svelte';

	let { thread }: { thread: ThreadData } = $props();

	const result = $derived(
		(page.form && typeof page.form === 'object' && 'comment' in page.form
			? page.form.comment
			: null) as CommentFormResult | null
	);
	const pageQuery = (n: number) => (n > 1 ? `?cpage=${n}` : '?');
	const here = $derived(`${page.url.pathname}${thread.page > 1 ? `?cpage=${thread.page}` : ''}`);
	/** The comment opened for editing: `?cedit=`, or the one an edit refusal was about. */
	const editingId = $derived(result?.action === 'edit' && result.id ? result.id : thread.editingId);
	let deleting = $state<string | null>(null);

	/**
	 * RB-20 Part B: after a comment is posted or edited, the action redirects to `#comment-<id>`; that comment gets the
	 * just-saved highlight. Only for a navigation inside the app, never on a page load or reload.
	 */
	afterNavigate((navigation) => {
		if (navigation.type === 'enter') return;
		const id = navigation.to?.url.hash.match(/^#comment-([\w-]+)$/)?.[1];
		if (id) markSaved(document.getElementById(`comment-${id}`));
	});
</script>

<section id="comments" class="thread" aria-labelledby="comments-heading">
	<h2 id="comments-heading">
		Comments{#if thread.total > 0}<span class="total">{thread.total}</span>{/if}
	</h2>

	{#if result?.action === 'delete'}<Banner tone="error" message={result.error} />{/if}

	{#if thread.total === 0}
		<p class="empty">No comments yet — start the discussion.</p>
	{:else}
		{#if thread.pageCount > 1}
			<nav class="pager" aria-label="Comment pages">
				{#if thread.page > 1}
					<Button href="{pageQuery(thread.page - 1)}#comments" size="sm">Older comments</Button>
				{/if}
				<span>Page {thread.page} of {thread.pageCount}</span>
				{#if thread.page < thread.pageCount}
					<Button href="{pageQuery(thread.page + 1)}#comments" size="sm">Newer comments</Button>
				{/if}
			</nav>
		{/if}
		<ol class="list">
			{#each thread.comments as c (c.id)}
				<li
					id="comment-{c.id}"
					class="comment"
					in:rise|local
					out:leave|local={{ instant: true }}
					animate:flip={flipParams(thread.comments.length)}
				>
					<Avatar name={c.authorName} seed={c.authorId} />
					<div class="content">
						<p class="meta">
							<span class="author">{c.authorName}</span>
							<a class="when" href="{here}#comment-{c.id}"><RelativeTime at={c.createdAt} /></a>
							{#if c.edited}<span class="edited">edited</span>{/if}
						</p>
						{#if editingId === c.id && c.canEdit}
							{@const mine = result?.action === 'edit' && result.id === c.id ? result : null}
							{#if mine?.current !== undefined}
								<div class="stored">
									<p class="stored-label">Current version</p>
									<Markdown source={mine.current} names={thread.names} />
								</div>
							{/if}
							<CommentForm
								action="commentEdit"
								label="Edit comment"
								submitLabel="Save"
								initial={mine?.body ?? c.body}
								error={mine?.error ?? null}
								hidden={{
									commentId: c.id,
									expectedUpdatedAt: String(mine?.expectedUpdatedAt ?? c.updatedAt)
								}}
								cancelHref="{here}#comment-{c.id}"
								rows={5}
							/>
						{:else}
							<div class="body"><Markdown source={c.body} names={thread.names} /></div>
							{#if c.canEdit || c.canDelete}
								<div class="actions">
									{#if c.canEdit}
										<Button
											href="{pageQuery(thread.page)}{thread.page > 1
												? '&'
												: ''}cedit={c.id}#comment-{c.id}"
											size="sm"
											variant="ghost">Edit</Button
										>
									{/if}
									{#if c.canDelete}
										<form
											method="POST"
											action="?/commentDelete"
											use:enhance={({ cancel }) => {
												if (!confirm('Delete this comment? This cannot be undone.'))
													return cancel();
												deleting = c.id;
												return async ({ update }) => {
													await update();
													deleting = null;
												};
											}}
										>
											<input type="hidden" name="commentId" value={c.id} />
											<input type="hidden" name="cpage" value={thread.page} />
											<Button
												type="submit"
												size="sm"
												variant="ghost"
												loading={deleting === c.id}
												loadingLabel="Deleting…">Delete</Button
											>
										</form>
									{/if}
								</div>
							{/if}
						{/if}
					</div>
				</li>
			{/each}
		</ol>
	{/if}

	<div class="new">
		<CommentForm
			action="commentCreate"
			label="Add a comment"
			submitLabel="Comment"
			initial={result?.action === 'create' ? (result.body ?? '') : ''}
			error={result?.action === 'create' ? result.error : null}
		/>
	</div>
</section>

<style>
	.thread {
		display: grid;
		gap: 14px;
		min-width: 0;
		margin-top: 24px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
	}
	h2 {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		font-size: 16px;
		font-weight: 600;
	}
	.total {
		min-width: 20px;
		padding: 0 7px;
		border-radius: 999px;
		background: var(--surface-3);
		color: var(--muted);
		font-size: 12px;
		font-weight: 500;
		line-height: 20px;
		text-align: center;
	}
	.empty {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.pager {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		color: var(--muted);
		font-size: 13px;
	}
	.list {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.comment {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 10px;
		padding: 10px 0;
	}
	.comment + .comment {
		border-top: 1px solid var(--border);
	}
	.comment:target .content {
		border-radius: var(--radius-m);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}
	.content {
		display: grid;
		gap: 6px;
		min-width: 0;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 8px;
		margin: 0;
		font-size: 13px;
	}
	.author {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.when {
		color: var(--muted);
		text-decoration: none;
	}
	.when:hover {
		text-decoration: underline;
	}
	.edited {
		color: var(--muted);
		font-style: italic;
	}
	.body {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-left: -10px;
	}
	.stored {
		padding: 10px 12px;
		border: 1px solid var(--warning);
		border-radius: var(--radius-m);
		background: var(--warning-soft);
	}
	.stored-label {
		margin: 0 0 4px;
		font-size: 12px;
		font-weight: 600;
	}
	.new {
		min-width: 0;
	}
</style>
