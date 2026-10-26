<script lang="ts">
	import AttachmentPanel from '#lib/ui/attachments/AttachmentPanel.svelte';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import LocalTime from '#lib/ui/kit/LocalTime.svelte';
	import Markdown from '#lib/ui/kit/Markdown.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Breadcrumbs from '../Breadcrumbs.svelte';
	import PageTree from '../PageTree.svelte';
	import CommentThread from '#lib/ui/comments/CommentThread.svelte';

	let { data } = $props();
	const page = $derived(data.page);
	const space = $derived(page.project ? page.project.name : 'Team');
	const newChildHref = $derived(`/kb/new?parent=${page.id}`);
</script>

<Breadcrumbs project={page.project} ancestors={data.breadcrumbs} />

<div class="layout">
	<details class="tree-drawer">
		<summary>Pages in {space}</summary>
		<div class="drawer-body">
			<PageTree
				nodes={data.tree.nodes}
				currentId={page.id}
				openIds={data.tree.openIds}
				label="Pages in {space}"
			/>
		</div>
	</details>

	<article class="content">
		<PageHeader title={page.title}>
			{#snippet actions()}
				<Button href="/kb/{page.id}/edit" variant="primary">Edit</Button>
				<Button href="/kb/{page.id}/history">History</Button>
				<Button href="/kb/{page.id}/move">Move</Button>
				{#if data.canDelete}
					<Button href="/kb/{page.id}/delete" variant="danger">Delete</Button>
				{/if}
			{/snippet}
		</PageHeader>

		<p class="meta">
			{#if page.project?.status === 'archived'}<Badge tone="warning">Archived project</Badge>{/if}
			<span>Created by {page.createdByName}</span>
			<span
				>Last edited by {page.editedByName ?? 'unknown'}
				<LocalTime at={page.editedAt} withTime /></span
			>
			<span>Revision {page.revision}</span>
		</p>

		<Banner tone="success" message={data.notice} />

		<div class="body">
			<Markdown source={page.body} empty="This page is empty. Edit it to add content." />
		</div>

		<section class="children" aria-labelledby="children-heading">
			<div class="children-head">
				<h2 id="children-heading">Subpages</h2>
				<Button href={newChildHref} size="sm">New subpage</Button>
			</div>
			{#if data.children.length === 0}
				<p class="muted">No subpages.</p>
			{:else}
				<ul>
					{#each data.children as child (child.id)}
						<li><a href="/kb/{child.id}">{child.title}</a></li>
					{/each}
				</ul>
			{/if}
		</section>

		<!-- RB-04:attachments -->
		<AttachmentPanel panel={data.attachments} />
		<!-- RB-03:comments -->
		<CommentThread thread={data.comments} />
	</article>

	<aside class="tree-aside" aria-labelledby="tree-heading">
		<h2 id="tree-heading">Pages in {space}</h2>
		<PageTree
			nodes={data.tree.nodes}
			currentId={page.id}
			openIds={data.tree.openIds}
			label="Pages in {space}"
		/>
	</aside>
</div>

<style>
	.layout {
		display: grid;
		gap: 16px;
		min-width: 0;
	}
	.content {
		min-width: 0;
	}
	/* Phones and tablets: the outline is a collapsible section above the page; wide screens: a side column. */
	.tree-drawer {
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.tree-drawer summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		padding: 0 14px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
	}
	.drawer-body {
		padding: 0 8px 8px;
		max-height: 60dvh;
		overflow-y: auto;
	}
	.tree-aside {
		display: none;
	}
	@media (min-width: 1100px) {
		.layout {
			grid-template-columns: 240px minmax(0, 1fr);
			grid-template-areas: 'tree content';
			align-items: start;
		}
		.tree-drawer {
			display: none;
		}
		.content {
			grid-area: content;
		}
		.tree-aside {
			grid-area: tree;
			position: sticky;
			top: 16px;
			display: block;
			max-height: calc(100dvh - 32px);
			overflow-y: auto;
			padding-right: 8px;
			border-right: 1px solid var(--border);
		}
		.tree-aside h2 {
			margin: 0 0 8px 6px;
			color: var(--muted);
			font-size: 13px;
			font-weight: 600;
		}
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 14px;
		margin: -10px 0 18px;
		color: var(--muted);
		font-size: 13px;
	}
	.body {
		margin-bottom: 28px;
	}
	.children {
		padding-top: 16px;
		border-top: 1px solid var(--border);
	}
	.children-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 8px;
	}
	.children h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.children ul {
		margin: 0;
		padding-left: 1.2em;
	}
	.children li {
		padding: 2px 0;
	}
	.children a {
		color: var(--accent);
	}
	@media (pointer: coarse) {
		.children a {
			display: inline-flex;
			align-items: center;
			min-height: 44px;
		}
	}
	.muted {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
</style>
