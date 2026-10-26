/**
 * True for the error `fetch` throws when a request never reached the server (RB-20). Every browser throws a
 * TypeError, with its own message: Chromium "Failed to fetch", Safari "Load failed", Firefox "NetworkError when
 * attempting to fetch resource.". Any TypeError while the browser says it is offline counts too. A TypeError from a
 * bug in the page's own code has none of these messages and stays an ordinary error.
 */
export function isNetworkError(error: unknown, online: boolean): boolean {
	if (!(error instanceof TypeError)) return false;
	if (!online) return true;
	return /failed to fetch|load failed|networkerror|network request failed|network connection was lost/i.test(
		error.message
	);
}
