<!--
	Avatar: a person's initials in a tinted circle; no images are fetched. `seed` (the user id) picks a stable tint,
	so two people with one name still differ. Decorative next to a visible name (the default); pass
	`decorative={false}` when the avatar stands alone, and it is labelled with the name.
-->
<script lang="ts">
	import { avatarTint, initials } from './initials';

	let {
		name,
		seed = name,
		size = 'md',
		decorative = true
	}: {
		name: string;
		seed?: string;
		size?: 'sm' | 'md' | 'lg';
		decorative?: boolean;
	} = $props();
</script>

<span
	class="avatar {size} tint-{avatarTint(seed)}"
	role={decorative ? undefined : 'img'}
	aria-hidden={decorative ? 'true' : undefined}
	aria-label={decorative ? undefined : name}
	title={decorative ? undefined : name}>{initials(name)}</span
>

<style>
	.avatar {
		display: inline-grid;
		place-items: center;
		flex: none;
		border-radius: 50%;
		font-weight: 600;
		line-height: 1;
		letter-spacing: 0.02em;
		user-select: none;
	}
	.sm {
		width: 22px;
		height: 22px;
		font-size: 10px;
	}
	.md {
		width: 28px;
		height: 28px;
		font-size: 11px;
	}
	.lg {
		width: 40px;
		height: 40px;
		font-size: 15px;
	}
	/* Text is --fg on a light tint (AA in both themes: the tint mixes with the surface). */
	.avatar {
		color: var(--fg);
	}
	.tint-0 {
		background: color-mix(in srgb, #b4233c 20%, var(--surface));
	}
	.tint-1 {
		background: color-mix(in srgb, #1d6fd1 20%, var(--surface));
	}
	.tint-2 {
		background: color-mix(in srgb, #16803c 20%, var(--surface));
	}
	.tint-3 {
		background: color-mix(in srgb, #b26a00 22%, var(--surface));
	}
	.tint-4 {
		background: color-mix(in srgb, #7a3fd1 20%, var(--surface));
	}
	.tint-5 {
		background: color-mix(in srgb, #0f8a8a 22%, var(--surface));
	}
</style>
