<script lang="ts">
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import Avatar from '#lib/ui/kit/Avatar.svelte';
	import Icon from '#lib/ui/kit/Icon.svelte';
	import Toaster from '#lib/ui/kit/Toaster.svelte';
	import InstallEntry from '#lib/ui/pwa/InstallEntry.svelte';
	import InstallSteps from '#lib/ui/pwa/InstallSteps.svelte';
	import OfflineBanner from '#lib/ui/pwa/OfflineBanner.svelte';
	import RefreshAction from '#lib/ui/pwa/RefreshAction.svelte';
	import { signalSignedOut } from '#lib/ui/pwa/register.svelte';
	import {
		FOOTER_ITEMS,
		moreSheetEntries,
		NAV_SECTIONS,
		NOTIFICATIONS,
		SEARCH,
		TAB_ITEMS,
		visibleTo
	} from '#lib/ui/shell/nav';
	import NewDot from '#lib/ui/shell/NewDot.svelte';
	import { parentHref } from '#lib/ui/shell/route-parent';
	import UpdateBanner from '#lib/ui/shell/UpdateBanner.svelte';

	let { data, children } = $props();

	const isAdmin = $derived(data.user.role === 'admin');
	const sections = $derived(
		NAV_SECTIONS.map((section) => ({ ...section, items: section.items.filter(visibleTo(isAdmin)) }))
	);
	const footerItems = $derived(FOOTER_ITEMS.filter(visibleTo(isAdmin)));
	const sheetEntries = $derived(moreSheetEntries(isAdmin));
	const sheetItems = $derived(
		sheetEntries.flatMap((entry) => (entry.kind === 'link' ? [entry.item] : []))
	);

	const unreadLabel = $derived(data.unread >= 100 ? '99+' : String(data.unread));
	/** RB-06: leave requests this user may decide, shown on the Time off entry. */
	const approvalsLabel = $derived(
		data.pendingApprovals >= 100 ? '99+' : String(data.pendingApprovals)
	);

	function isCurrent(href: string): boolean {
		const path = page.url.pathname;
		return href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`);
	}
	const moreCurrent = $derived(sheetItems.some((item) => isCurrent(item.href)));

	/**
	 * The phone "More" sheet: a <details>, so it opens without JavaScript too. The element owns the open state
	 * (`moreOpen` only mirrors it for the backdrop), so a sheet tapped open before the page hydrated stays open.
	 * Closed on every navigation, Escape and a tap outside.
	 */
	let moreEl = $state<HTMLDetailsElement>();
	let moreOpen = $state(false);
	const closeMore = () => {
		if (moreEl) moreEl.open = false;
	};
	onMount(() => {
		moreOpen = moreEl?.open ?? false;
	});
	/**
	 * RB-20: in-app pages behind this one in the session history (never `document.referrer`). The standalone back control
	 * goes back through history while there is one, else to the page's parent route (route-parent.ts).
	 */
	let depth = 0;
	afterNavigate((navigation) => {
		if (navigation.type !== 'enter') closeMore();
		if (navigation.type === 'popstate') depth = Math.max(0, depth + (navigation.delta ?? -1));
		else if (navigation.type !== 'enter') depth += 1;
	});
	const backHref = $derived(parentHref(page.route.id, page.params));
	function back(event: MouseEvent) {
		if (depth === 0) return;
		event.preventDefault();
		history.back();
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && moreOpen) closeMore();
	}}
/>

<a class="skip" href="#main">Skip to content</a>

<div class="shell">
	<!-- ≥ 768 px: the left sidebar. -->
	<aside class="sidebar">
		<div class="side-head">
			<a class="brand" href="/"><span class="mark" aria-hidden="true"></span>Ruby</a>
			<div class="side-actions">
				<a
					href={SEARCH.href}
					class="icon-link"
					aria-label={SEARCH.label}
					title={SEARCH.label}
					aria-current={isCurrent(SEARCH.href) ? 'page' : undefined}
				>
					<Icon name={SEARCH.icon} />
				</a>
				<a
					href={NOTIFICATIONS.href}
					class="icon-link"
					aria-label="{NOTIFICATIONS.label}, {data.unread} unread"
					title={NOTIFICATIONS.label}
					aria-current={isCurrent(NOTIFICATIONS.href) ? 'page' : undefined}
				>
					<Icon name={NOTIFICATIONS.icon} />
					{#if data.unread > 0}<span class="dot-count" aria-hidden="true">{unreadLabel}</span>{/if}
				</a>
			</div>
		</div>
		<nav aria-label="Main">
			{#each sections as section, i (i)}
				<div class="section">
					{#if section.label}<p class="section-label">{section.label}</p>{/if}
					<ul>
						{#each section.items as item (item.href)}
							<li>
								<a
									href={item.href}
									class="nav-link"
									aria-current={isCurrent(item.href) ? 'page' : undefined}
								>
									<Icon name={item.icon} />
									<span class="label">{item.label}</span>
									{#if item.href === '/time-off' && data.pendingApprovals > 0}
										<span class="count" aria-label="{approvalsLabel} to decide"
											>{approvalsLabel}</span
										>
									{/if}
								</a>
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</nav>
		<ul class="footer-links">
			{#each footerItems as item (item.href)}
				<li>
					<a
						href={item.href}
						class="nav-link quiet"
						aria-current={isCurrent(item.href) ? 'page' : undefined}
					>
						<Icon name={item.icon} />
						<span class="label">{item.label}</span>
						{#if item.href === '/releases'}<NewDot />{/if}
					</a>
				</li>
			{/each}
		</ul>
		<div class="account">
			<a
				href="/account"
				class="account-link"
				aria-current={isCurrent('/account') ? 'page' : undefined}
			>
				<Avatar name={data.user.name} seed={data.user.id} />
				<span class="who">
					<span class="name">{data.user.name}</span>
					<span class="email">{data.user.email}</span>
				</span>
			</a>
			<form method="POST" action="/logout" onsubmit={signalSignedOut}>
				<button type="submit" class="signout" aria-label="Sign out" title="Sign out">
					<Icon name="logout" />
				</button>
			</form>
		</div>
	</aside>

	<!-- < 768 px: a sticky top bar and a fixed bottom tab bar instead. -->
	<header class="topbar">
		<div class="top-start">
			{#if backHref}
				<!-- RB-20: shown in the installed app only (app.css hides it in a browser tab, which has its own back). -->
				<a class="back-link" href={backHref} onclick={back} aria-label="Back"
					><Icon name="back" size={20} /></a
				>
			{/if}
			<a class="brand" href="/"><span class="mark" aria-hidden="true"></span>Ruby</a>
		</div>
		<div class="top-actions">
			<a href="/search" class="icon-link" aria-label="Search"><Icon name="search" size={20} /></a>
			<a href="/notifications" class="icon-link" aria-label="Notifications, {data.unread} unread">
				<Icon name="bell" size={20} />
				{#if data.unread > 0}<span class="dot-count" aria-hidden="true">{unreadLabel}</span>{/if}
			</a>
		</div>
	</header>

	<main id="main" class="main" tabindex="-1">
		{@render children()}
	</main>

	<div class="banners">
		<UpdateBanner />
		<OfflineBanner />
	</div>
	<InstallSteps />

	<nav class="tabbar" aria-label="Main">
		{#each TAB_ITEMS as item (item.href)}
			<a href={item.href} class="tab" aria-current={isCurrent(item.href) ? 'page' : undefined}>
				<Icon name={item.icon} size={20} />
				<span>{item.short ?? item.label}</span>
			</a>
		{/each}
		<details
			class="more"
			bind:this={moreEl}
			ontoggle={(event) => (moreOpen = event.currentTarget.open)}
		>
			<summary class="tab" class:current={moreCurrent}>
				<Icon name="more" size={20} />
				<span>More</span>
				{#if data.unread > 0 || data.pendingApprovals > 0}<span
						class="more-dot"
						aria-label={data.unread > 0 ? `${unreadLabel} unread` : `${approvalsLabel} to decide`}
					></span>{/if}
			</summary>
			<div class="sheet" role="group" aria-label="More">
				<ul>
					{#each sheetEntries as entry (entry.kind === 'link' ? entry.item.href : entry.action.id)}
						{#if entry.kind === 'action'}
							{#if entry.action.id === 'install'}<InstallEntry
									variant="sheet"
								/>{:else}<RefreshAction variant="sheet" />{/if}
						{:else}
							{@const item = entry.item}
							<li>
								<a
									href={item.href}
									class="sheet-link"
									aria-current={isCurrent(item.href) ? 'page' : undefined}
								>
									<Icon name={item.icon} />
									<span class="label">{item.label}</span>
									{#if item.href === '/notifications' && data.unread > 0}
										<span class="count">{unreadLabel}</span>
									{:else if item.href === '/time-off' && data.pendingApprovals > 0}
										<span class="count" aria-label="{approvalsLabel} to decide"
											>{approvalsLabel}</span
										>
									{/if}
									{#if item.href === '/releases'}<NewDot />{/if}
								</a>
							</li>
						{/if}
					{/each}
					<li>
						<form method="POST" action="/logout" onsubmit={signalSignedOut}>
							<button type="submit" class="sheet-link"><Icon name="logout" />Sign out</button>
						</form>
					</li>
				</ul>
			</div>
		</details>
	</nav>
	{#if moreOpen}
		<button class="backdrop" type="button" aria-label="Close menu" onclick={closeMore}></button>
	{/if}
</div>

<Toaster />

<style>
	/*
	 * The shell in Kumo's look (docs/design/DESIGN_SYSTEM.md): a white sidebar with a hairline edge and 34 px items
	 * whose current one sits on a tint; on phones a blurred top bar, a bottom tab bar with a blue bar over the current
	 * tab, and a More sheet styled as a Kumo menu.
	 */
	.skip {
		position: absolute;
		left: -9999px;
		top: 0;
		z-index: 50;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		background: var(--surface);
		box-shadow: var(--shadow-2);
		color: var(--fg);
	}
	.skip:focus {
		left: max(8px, var(--sai-left));
		top: calc(8px + var(--sai-top));
	}

	.shell {
		min-height: 100dvh;
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		color: var(--fg-strong);
		font-weight: 600;
		font-size: var(--text-lg);
		letter-spacing: -0.02em;
		text-decoration: none;
	}
	/* Ruby's own mark: a small ruby-red square (the one colour the shell keeps from before Kumo). */
	.mark {
		width: 16px;
		height: 16px;
		border-radius: 5px;
		background: var(--logo);
		box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.12);
	}
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.count {
		margin-left: auto;
		min-width: 20px;
		padding: 0 6px;
		box-sizing: border-box;
		border-radius: 999px;
		background: var(--accent);
		color: var(--accent-fg);
		font-size: 11px;
		font-weight: 600;
		line-height: 18px;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	/* ── Phone (default): top bar, content, bottom tab bar ─────────────────────────────────────────── */
	.sidebar {
		display: none;
	}
	.topbar {
		position: sticky;
		top: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		justify-content: space-between;
		box-sizing: border-box;
		height: calc(var(--topbar-h) + var(--sai-top));
		padding: var(--sai-top) max(8px, var(--sai-right)) 0 max(16px, var(--sai-left));
		border-bottom: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface) 88%, transparent);
		backdrop-filter: saturate(1.8) blur(12px);
	}
	.top-actions {
		display: flex;
		gap: 2px;
	}
	.top-start {
		display: flex;
		align-items: center;
		gap: 2px;
		min-width: 0;
	}
	/* RB-20: the back control exists for the installed app only, where there is no browser back button. */
	.back-link {
		display: none;
		place-items: center;
		width: 44px;
		height: 44px;
		margin-left: -12px;
		border-radius: var(--radius-m);
		color: var(--fg);
	}
	.back-link:hover {
		background: var(--surface-2);
	}
	@media (display-mode: standalone) {
		.back-link {
			display: grid;
		}
	}
	:global(html[data-display='standalone']) .back-link {
		display: grid;
	}
	/*
	 * The update banner and the offline notice, stacked so they never overlap each other, above the tab bar and inside
	 * the safe areas. Below the tab bar's stacking context (30), so the More sheet opened from it covers them.
	 */
	.banners {
		position: fixed;
		z-index: 25;
		left: max(8px, var(--sai-left));
		right: max(8px, var(--sai-right));
		bottom: calc(var(--tabbar-h) + var(--sai-bottom) + 8px);
		display: grid;
		gap: 8px;
		pointer-events: none;
	}
	.banners > :global(*) {
		pointer-events: auto;
	}
	.icon-link {
		position: relative;
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		border-radius: var(--radius-m);
		color: var(--muted);
		transition:
			background-color var(--dur-fast) var(--ease),
			color var(--dur-fast) var(--ease);
	}
	.icon-link:hover {
		color: var(--fg);
		background: var(--surface-2);
	}
	.dot-count {
		position: absolute;
		top: 6px;
		right: 4px;
		min-width: 16px;
		padding: 0 4px;
		box-sizing: border-box;
		border-radius: 999px;
		background: var(--accent);
		box-shadow: 0 0 0 2px var(--surface);
		color: var(--accent-fg);
		font-size: 10px;
		font-weight: 600;
		line-height: 16px;
		text-align: center;
	}
	.main {
		box-sizing: border-box;
		min-width: 0;
		padding: 20px max(16px, var(--sai-right)) calc(var(--tabbar-h) + var(--sai-bottom) + 24px)
			max(16px, var(--sai-left));
	}
	.main:focus {
		outline: none;
	}
	.tabbar {
		position: fixed;
		inset: auto 0 0 0;
		z-index: 30;
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		box-sizing: border-box;
		/* The tabs' own height, the home-indicator inset and the 1 px top border. */
		height: calc(var(--tabbar-h) + var(--sai-bottom) + 1px);
		padding: 0 var(--sai-right) var(--sai-bottom) var(--sai-left);
		border-top: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface) 92%, transparent);
		backdrop-filter: saturate(1.8) blur(12px);
	}
	.tab {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 3px;
		min-width: 0;
		min-height: 44px;
		height: var(--tabbar-h);
		color: var(--muted);
		font-size: 11px;
		font-weight: 500;
		text-decoration: none;
		cursor: pointer;
		list-style: none;
		transition: color var(--dur-fast) var(--ease);
	}
	.tab::-webkit-details-marker {
		display: none;
	}
	/* Kumo's underline marker, moved to the top edge of the current tab. */
	.tab::before {
		content: '';
		position: absolute;
		top: -1px;
		left: 50%;
		width: 24px;
		height: 2px;
		margin-left: -12px;
		border-radius: 0 0 2px 2px;
		background: transparent;
	}
	.tab[aria-current='page'],
	.tab.current {
		color: var(--fg);
	}
	.tab[aria-current='page']::before,
	.tab.current::before {
		background: var(--brand);
	}
	.tab:focus-visible {
		outline-offset: -2px;
	}
	.tab span {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.more-dot {
		position: absolute;
		top: 8px;
		left: calc(50% + 6px);
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 0 2px var(--surface);
	}
	.sheet {
		position: fixed;
		z-index: 40;
		left: max(8px, var(--sai-left));
		right: max(8px, var(--sai-right));
		bottom: calc(var(--tabbar-h) + var(--sai-bottom) + 8px);
		padding: 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--control);
		box-shadow: var(--shadow-2);
		/* RB-20: scrolling the sheet never scrolls the page behind it. */
		overscroll-behavior: contain;
	}
	.sheet-link {
		display: flex;
		align-items: center;
		gap: 12px;
		box-sizing: border-box;
		width: 100%;
		min-height: 48px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-m);
		background: none;
		color: var(--fg);
		font: inherit;
		font-size: 15px;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}
	.sheet-link :global(svg) {
		color: var(--muted);
	}
	.sheet-link:hover {
		background: var(--surface-2);
	}
	.sheet-link[aria-current='page'] {
		background: var(--surface-2);
		font-weight: 500;
	}
	.sheet-link[aria-current='page'] :global(svg) {
		color: var(--fg);
	}
	.sheet li:last-child {
		margin-top: 4px;
		padding-top: 4px;
		border-top: 1px solid var(--border);
	}
	/* Kumo's backdrop: the recessed surface, not a dark scrim. */
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 25;
		border: 0;
		background: var(--backdrop);
		backdrop-filter: blur(1px);
	}

	/*
	 * RB-20 Part B motion. The More sheet enters in pure CSS (it is a <details>, so it opens without JavaScript too):
	 * up 16 px and in, `--dur-slow`; the backdrop fades. Under reduced motion only the fade remains. The bars keep their
	 * own view-transition names, so a page cross-fade (root layout) changes only the content. A pressed tab dips a little.
	 */
	.more[open] .sheet,
	.backdrop {
		transition: opacity var(--dur-fast) var(--ease);
	}
	@starting-style {
		.more[open] .sheet,
		.backdrop {
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: no-preference) {
		.topbar {
			view-transition-name: topbar;
		}
		.tabbar {
			view-transition-name: tabbar;
		}
		.more[open] .sheet {
			transition:
				opacity var(--dur-slow) var(--ease-out),
				transform var(--dur-slow) var(--ease-out);
		}
		@starting-style {
			.more[open] .sheet {
				transform: translateY(16px);
			}
		}
		.tab {
			transition:
				color var(--dur-fast) var(--ease),
				transform var(--dur-fast) var(--ease);
		}
		.tab:active {
			transform: scale(0.97);
		}
	}

	/* ── Tablet and desktop (≥ 768 px): left sidebar, no top or tab bar ───────────────────────────── */
	@media (min-width: 768px) {
		.shell {
			display: grid;
			grid-template-columns: calc(var(--sidebar-w) + var(--sai-left)) minmax(0, 1fr);
		}
		.topbar,
		.tabbar,
		.backdrop {
			display: none;
		}
		.banners {
			left: auto;
			right: max(16px, var(--sai-right));
			bottom: calc(16px + var(--sai-bottom));
			width: min(420px, calc(100vw - 32px));
		}
		.sidebar {
			position: sticky;
			top: 0;
			display: flex;
			flex-direction: column;
			box-sizing: border-box;
			height: 100dvh;
			overflow-y: auto;
			padding: var(--sai-top) 0 var(--sai-bottom) var(--sai-left);
			border-right: 1px solid var(--border);
			background: var(--surface);
		}
		.side-head {
			flex: none;
			display: flex;
			align-items: center;
			justify-content: space-between;
			box-sizing: border-box;
			height: 52px;
			padding: 0 6px 0 18px;
			border-bottom: 1px solid var(--border);
		}
		.side-actions {
			display: flex;
		}
		.side-actions .icon-link {
			width: 34px;
			height: 34px;
		}
		.side-actions .icon-link[aria-current='page'] {
			background: var(--surface-2);
			color: var(--fg-strong);
		}
		.side-actions .dot-count {
			top: 2px;
			right: 0;
		}
		.sidebar nav {
			flex: 1;
			padding: 12px 8px;
		}
		.section + .section {
			margin-top: 18px;
		}
		.section-label {
			margin: 0 0 4px;
			padding: 0 10px;
			color: var(--muted);
			font-size: var(--text-xs);
			font-weight: 500;
		}
		.footer-links {
			padding: 8px;
		}
		.nav-link.quiet {
			color: var(--muted);
		}
		.nav-link {
			display: flex;
			align-items: center;
			gap: 10px;
			min-height: 34px;
			padding: 0 10px;
			border-radius: var(--radius-m);
			color: var(--fg);
			font-size: var(--text-sm);
			font-weight: 500;
			text-decoration: none;
			transition: background-color var(--dur-fast) var(--ease);
		}
		.nav-link :global(svg) {
			color: var(--muted);
		}
		.nav-link:hover {
			background: var(--surface-2);
		}
		.nav-link[aria-current='page'] {
			background: var(--surface-2);
			color: var(--fg-strong);
		}
		.nav-link[aria-current='page'] :global(svg) {
			color: var(--fg-strong);
		}
		li + li {
			margin-top: 2px;
		}
		.account {
			display: flex;
			align-items: center;
			gap: 4px;
			padding: 8px;
			border-top: 1px solid var(--border);
		}
		.account-link {
			display: flex;
			align-items: center;
			gap: 10px;
			flex: 1;
			min-width: 0;
			padding: 6px 8px;
			border-radius: var(--radius-m);
			color: var(--fg);
			text-decoration: none;
			transition: background-color var(--dur-fast) var(--ease);
		}
		.account-link:hover,
		.account-link[aria-current='page'] {
			background: var(--surface-2);
		}
		.who {
			display: grid;
			min-width: 0;
		}
		.name,
		.email {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.name {
			font-size: var(--text-sm);
			font-weight: 500;
		}
		.email {
			color: var(--muted);
			font-size: var(--text-xs);
		}
		.signout {
			display: grid;
			place-items: center;
			width: 34px;
			height: 34px;
			border: 0;
			border-radius: var(--radius-m);
			background: none;
			color: var(--muted);
			cursor: pointer;
			transition:
				background-color var(--dur-fast) var(--ease),
				color var(--dur-fast) var(--ease);
		}
		.signout:hover {
			background: var(--surface-2);
			color: var(--fg);
		}
		.main {
			width: 100%;
			max-width: 1120px;
			padding: calc(28px + var(--sai-top)) max(32px, var(--sai-right))
				calc(48px + var(--sai-bottom)) 32px;
		}
	}
</style>
