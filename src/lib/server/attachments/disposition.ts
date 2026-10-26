/**
 * `Content-Disposition` for a download (RFC 6266 with an RFC 5987 `filename*`). The quoted ASCII fallback has every
 * non-printable or non-ASCII character, quote, backslash and percent sign replaced by `_`, so no CR/LF or quote can
 * leave the parameter; `filename*` carries the real name percent-encoded as UTF-8.
 */
export function contentDisposition(kind: 'attachment' | 'inline', filename: string): string {
	const fallback = filename.replace(/[^\x20-\x7e]|["\\%]/g, '_') || 'file';
	// Unpaired surrogates would make encodeURIComponent throw; cleanFilename removes them, this is the backstop.
	const wellFormed = filename.replace(/\p{Cs}/gu, '_') || 'file';
	// encodeURIComponent leaves ' ( ) * unencoded; none of them is an RFC 5987 attr-char.
	const encoded = encodeURIComponent(wellFormed).replace(
		/['()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);
	return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
