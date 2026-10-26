<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { dev } from '$app/env';
	import { onNavigate } from '$app/navigation';
	import { SPLASH_LINKS } from '#lib/shared/splash';
	import { PHONE_QUERY, pageTransitionAllowed, reducedMotion } from '#lib/ui/motion';
	import { captureInstallPrompt, isStandalone } from '#lib/ui/pwa/install.svelte';
	import { watchConnection } from '#lib/ui/pwa/online.svelte';
	import { startServiceWorker } from '#lib/ui/pwa/register.svelte';

	let { children } = $props();

	/**
	 * RB-20 Part B: on phones, moving between pages cross-fades (View Transitions API; the effect is in app.css). One at a
	 * time: a new navigation skips the running one, and so does any new tap, so a fast second tap is never swallowed.
	 * Never under reduced motion, in a hidden tab, for a query-only change, or to and from sign-in and sign-out.
	 */
	let running: ViewTransition | null = null;
	onNavigate((navigation) => {
		running?.skipTransition();
		if (
			!pageTransitionAllowed({
				phone: matchMedia(PHONE_QUERY).matches,
				supported: typeof document.startViewTransition === 'function',
				reduced: reducedMotion(),
				hidden: document.hidden,
				from: navigation.from?.url,
				to: navigation.to?.url
			})
		)
			return;
		return new Promise<void>((resolve) => {
			const transition = document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
			running = transition;
			// A skipped transition rejects these; the navigation itself is unaffected.
			transition.ready.catch(() => {});
			transition.updateCallbackDone.catch(() => {});
			const skip = () => transition.skipTransition();
			addEventListener('pointerdown', skip, { capture: true, once: true });
			transition.finished
				.catch(() => {})
				.finally(() => {
					removeEventListener('pointerdown', skip, { capture: true });
					if (running === transition) running = null;
				});
		});
	});

	// RB-20: the service worker (never under `vite dev`), the install prompt and the online state, on every page.
	onMount(() => {
		// The installed app, as a hook for CSS next to `@media (display-mode: standalone)`: iOS also reports it through
		// `navigator.standalone`, and the standalone rules must hold there too (app.css, the app layout's back control).
		if (isStandalone()) document.documentElement.dataset.display = 'standalone';
		const stops = [startServiceWorker(!dev), captureInstallPrompt(), watchConnection()];
		return () => stops.forEach((stop) => stop());
	});
</script>

<svelte:head>
	<!-- RB-20: iOS launch images, one per iPhone size and colour scheme (src/lib/shared/splash.ts). -->
	{#each SPLASH_LINKS as link (link.href)}
		<link rel="apple-touch-startup-image" href={link.href} media={link.media} />
	{/each}
</svelte:head>

{@render children()}
