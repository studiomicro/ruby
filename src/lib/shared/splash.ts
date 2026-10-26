import { SPLASH_SCREENS, type SplashScreen } from './splash-screens';

/**
 * iOS launch images (RB-20). The head carries one `apple-touch-startup-image` link per iPhone size and colour scheme
 * (src/routes/+layout.svelte); Safari uses the link whose media query matches the device, other browsers ignore them
 * and never download the files.
 */

export type SplashScheme = 'light' | 'dark';

/** The media query iOS matches a launch image by: device size and ratio, portrait, and the colour scheme. */
export function splashMedia(screen: SplashScreen, scheme: SplashScheme): string {
	return (
		`(device-width: ${screen.width}px) and (device-height: ${screen.height}px) and ` +
		`(-webkit-device-pixel-ratio: ${screen.scale}) and (orientation: portrait) and ` +
		`(prefers-color-scheme: ${scheme})`
	);
}

/** Every link, the light image of a device before its dark one (an iOS that ignores the scheme shows the light one). */
export const SPLASH_LINKS: readonly { href: string; media: string }[] = SPLASH_SCREENS.flatMap(
	(screen) =>
		(['light', 'dark'] as const).map((scheme) => ({
			href: screen[scheme],
			media: splashMedia(screen, scheme)
		}))
);
