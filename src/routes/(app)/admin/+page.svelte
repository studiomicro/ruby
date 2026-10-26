<script lang="ts">
	import Card from '#lib/ui/kit/Card.svelte';
	import Icon, { type IconName } from '#lib/ui/kit/Icon.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';

	const SECTIONS: { href: string; title: string; text: string; icon: IconName }[] = [
		{
			href: '/admin/users',
			title: 'Users',
			text: 'Invite people, change roles and disable accounts.',
			icon: 'people'
		},
		{
			href: '/admin/labels',
			title: 'Team labels',
			text: 'Labels every project can use, like “Customer” or “Security”.',
			icon: 'tag'
		},
		{
			href: '/admin/attachments',
			title: 'Attachment retention',
			text: 'Purge files of items deleted a while ago.',
			icon: 'shield'
		}
	];
</script>

<PageHeader title="Admin" description="Settings only admins can change." />

<Card flush>
	<ul class="links">
		{#each SECTIONS as s (s.href)}
			<li>
				<a href={s.href}>
					<span class="icon"><Icon name={s.icon} /></span>
					<span class="text"
						><span class="title">{s.title}</span><span class="desc">{s.text}</span></span
					>
				</a>
			</li>
		{/each}
	</ul>
</Card>

<style>
	.links {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li + li {
		border-top: 1px solid var(--border);
	}
	a {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 56px;
		padding: 10px 16px;
		color: var(--fg);
		text-decoration: none;
	}
	a:hover {
		background: var(--surface-2);
	}
	.icon {
		display: inline-flex;
		color: var(--muted);
	}
	.text {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.title {
		font-weight: 500;
	}
	.desc {
		color: var(--muted);
		font-size: var(--text-sm);
	}
</style>
