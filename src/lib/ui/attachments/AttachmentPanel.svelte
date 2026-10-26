<!--
	AttachmentPanel (RB-04): the files on one task or page. The list (thumbnail for images, name as a download link,
	size, uploader, date, Delete when allowed), the "N of 20" counter and the upload form. Without JavaScript the
	upload form posts to /files and the delete form to /files/<id>/delete; both come back with a flash parameter the
	loader turns into `panel.flash`. With JavaScript: several files may be picked or dropped, each is sent on its own
	request in turn with a progress bar and its own error, and the list refreshes after the server confirms.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import LocalTime from '#lib/ui/kit/LocalTime.svelte';
	import {
		ATTACHMENT_ERROR_MESSAGES,
		attachmentError,
		humanSize,
		type AttachmentPanelData
	} from '#lib/shared/attachments';

	let { panel }: { panel: AttachmentPanelData } = $props();

	type Upload = {
		key: number;
		file: File;
		progress: number;
		status: 'queued' | 'uploading' | 'done' | 'error';
		error?: string;
	};

	let mounted = $state(false);
	let queue = $state<Upload[]>([]);
	let dragging = $state(false);
	let deletingId = $state<string | null>(null);
	let deleteError = $state<string | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	let nextKey = 0;
	let running = false;

	onMount(() => {
		mounted = true;
	});

	const count = $derived(panel.items.length);
	const full = $derived(count >= panel.max);
	const uploading = $derived(queue.some((u) => u.status === 'queued' || u.status === 'uploading'));
	const action = $derived(`/files?returnTo=${encodeURIComponent(panel.returnTo)}`);
	const headingId = $derived(`attachments-heading-${panel.targetId}`);
	const inputId = $derived(`attachment-file-${panel.targetId}`);

	const messageFor = (code: unknown) =>
		ATTACHMENT_ERROR_MESSAGES[attachmentError(String(code)) ?? 'storage'];

	/** One request, with progress; resolves with the error message, or null on 201. */
	function send(upload: Upload): Promise<string | null> {
		return new Promise((resolve) => {
			const body = new FormData();
			body.set('targetKind', panel.targetKind);
			body.set('targetId', panel.targetId);
			body.set('returnTo', panel.returnTo);
			body.set('file', upload.file, upload.file.name);
			const xhr = new XMLHttpRequest();
			xhr.open('POST', '/files');
			xhr.setRequestHeader('accept', 'application/json');
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable) upload.progress = Math.round((e.loaded / e.total) * 100);
			};
			xhr.onload = () => {
				if (xhr.status === 201) return resolve(null);
				let code: unknown = 'storage';
				try {
					code = (JSON.parse(xhr.responseText) as { error?: unknown }).error;
				} catch {
					/* not JSON (a signed-out 401, a proxy error): the generic message */
				}
				resolve(messageFor(code));
			};
			xhr.onerror = () => resolve(ATTACHMENT_ERROR_MESSAGES.storage);
			xhr.send(body);
		});
	}

	async function run() {
		if (running) return;
		running = true;
		try {
			for (let next = queue.find((u) => u.status === 'queued'); next;) {
				next.status = 'uploading';
				const failed = await send(next);
				next.status = failed ? 'error' : 'done';
				next.error = failed ?? undefined;
				if (!failed) await invalidateAll();
				next = queue.find((u) => u.status === 'queued');
			}
		} finally {
			running = false;
		}
	}

	/** Queues `files`; refuses at once what the server would refuse (size, empty, the per-item cap). */
	function enqueue(files: FileList | File[] | null | undefined) {
		const pending = queue.filter((u) => u.status === 'queued' || u.status === 'uploading').length;
		let room = panel.max - count - pending;
		for (const file of files ?? []) {
			const upload: Upload = { key: nextKey++, file, progress: 0, status: 'queued' };
			if (file.size === 0) upload.error = ATTACHMENT_ERROR_MESSAGES.empty;
			else if (file.size > panel.maxBytes) upload.error = ATTACHMENT_ERROR_MESSAGES.too_large;
			else if (room <= 0) upload.error = ATTACHMENT_ERROR_MESSAGES.limit;
			else room -= 1;
			if (upload.error) upload.status = 'error';
			queue.push(upload);
		}
		void run();
	}

	function onSubmit(event: SubmitEvent) {
		event.preventDefault();
		enqueue(fileInput?.files);
		if (fileInput) fileInput.value = '';
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		enqueue(event.dataTransfer?.files);
	}

	const dismiss = (key: number) => (queue = queue.filter((u) => u.key !== key));

	async function remove(item: AttachmentPanelData['items'][number]) {
		if (!confirm(`Delete “${item.filename}”? This cannot be undone.`)) return;
		deletingId = item.id;
		deleteError = null;
		try {
			const body = new URLSearchParams({ confirm: 'yes', returnTo: panel.returnTo });
			const res = await fetch(`/files/${item.id}/delete`, {
				method: 'POST',
				headers: { accept: 'application/json' },
				body
			});
			if (res.ok) await invalidateAll();
			else {
				const data = (await res.json().catch(() => ({}))) as { error?: unknown };
				deleteError = messageFor(data.error ?? 'not_found');
			}
		} catch {
			deleteError = 'Delete failed, try again';
		} finally {
			deletingId = null;
		}
	}
</script>

<section class="attachments" id="attachments" aria-labelledby={headingId}>
	<header class="head">
		<h2 id={headingId}>Attachments</h2>
		<span class="count" aria-label="{count} of {panel.max} attachments">{count} of {panel.max}</span
		>
	</header>

	<Banner tone={panel.flash?.tone ?? 'info'} message={panel.flash?.message} />
	<Banner tone="error" message={deleteError} />

	{#if count === 0}
		<p class="empty">No attachments</p>
	{:else}
		<ul class="list">
			{#each panel.items as item (item.id)}
				<li class="item">
					{#if item.image}
						<img
							class="thumb"
							src="/files/{item.id}?inline=1"
							alt=""
							loading="lazy"
							width="44"
							height="44"
						/>
					{:else}
						<span class="thumb icon" aria-hidden="true">
							<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor">
								<path
									stroke-width="1.75"
									stroke-linejoin="round"
									d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5zM14 3v4.5h4.5"
								/>
							</svg>
						</span>
					{/if}
					<div class="meta">
						<span class="name-row">
							<a class="name" href="/files/{item.id}" download={item.filename}>{item.filename}</a>
							{#if item.extension}
								<!-- The real type stays visible however long the name and wherever it is cut. -->
								<span class="ext" title="File type">{item.extension.toUpperCase()}</span>
							{/if}
						</span>
						<span class="sub">
							{humanSize(item.sizeBytes)} · {item.uploaderName || 'Former member'} ·
							<LocalTime at={item.createdAt} />
						</span>
					</div>
					{#if item.canDelete}
						{#if mounted}
							<Button
								variant="ghost"
								size="sm"
								loading={deletingId === item.id}
								loadingLabel="Deleting…"
								label="Delete {item.filename}"
								onclick={() => remove(item)}>Delete</Button
							>
						{:else}
							<details class="confirm">
								<summary>Delete</summary>
								<form method="post" action="/files/{item.id}/delete">
									<p>Delete this file? This cannot be undone.</p>
									<input type="hidden" name="confirm" value="yes" />
									<input type="hidden" name="returnTo" value={panel.returnTo} />
									<Button type="submit" variant="danger" size="sm">Delete file</Button>
								</form>
							</details>
						{/if}
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if queue.length}
		<ul class="queue" aria-label="Uploads">
			{#each queue as upload (upload.key)}
				<li class="upload {upload.status}">
					<span class="upload-name">{upload.file.name}</span>
					{#if upload.status === 'uploading' || upload.status === 'queued'}
						<progress max="100" value={upload.progress} aria-label="Uploading {upload.file.name}"
						></progress>
					{:else if upload.status === 'error'}
						<span class="upload-error" role="alert">{upload.error}</span>
						<Button variant="ghost" size="sm" onclick={() => dismiss(upload.key)}>Dismiss</Button>
					{:else}
						<span class="upload-done" role="status">Uploaded</span>
						<Button variant="ghost" size="sm" onclick={() => dismiss(upload.key)}>Dismiss</Button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if full}
		<p class="note">{ATTACHMENT_ERROR_MESSAGES.limit}.</p>
	{:else}
		<form
			class="upload-form"
			class:dragging
			method="post"
			{action}
			enctype="multipart/form-data"
			onsubmit={mounted ? onSubmit : undefined}
			ondragover={(e) => {
				e.preventDefault();
				dragging = true;
			}}
			ondragleave={() => (dragging = false)}
			ondrop={onDrop}
		>
			<input type="hidden" name="targetKind" value={panel.targetKind} />
			<input type="hidden" name="targetId" value={panel.targetId} />
			<input type="hidden" name="returnTo" value={panel.returnTo} />
			<label class="file-label" for={inputId}>
				{mounted ? 'Choose or drop files' : 'Choose a file'} (up to 25 MB each)
			</label>
			<div class="row">
				<input
					bind:this={fileInput}
					id={inputId}
					class="file"
					type="file"
					name="file"
					multiple={mounted}
					required
				/>
				<Button type="submit" loading={uploading} loadingLabel="Uploading…">Upload</Button>
			</div>
		</form>
	{/if}
</section>

<style>
	.attachments {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 10px;
		margin-top: 20px;
		min-width: 0;
	}
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}
	h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.count,
	.empty,
	.note,
	.sub {
		color: var(--muted);
		font-size: 13px;
	}
	.empty,
	.note {
		margin: 0;
	}
	.list,
	.queue {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		padding: 6px 0;
		border-bottom: 1px solid var(--border);
	}
	.thumb {
		flex: none;
		width: 44px;
		height: 44px;
		border-radius: var(--radius-s);
		object-fit: cover;
		background: var(--surface-2);
	}
	.icon {
		display: grid;
		place-items: center;
		color: var(--muted);
	}
	.meta {
		display: grid;
		flex: 1;
		min-width: 0;
	}
	.name-row {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.ext {
		flex: none;
		max-width: 12ch;
		overflow: hidden;
		padding: 2px 6px;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--muted);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.02em;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.name {
		display: block;
		min-width: 0;
		/* Block, not flex: text-overflow only cuts a block's own text. */
		line-height: 28px;
		overflow: hidden;
		color: var(--fg);
		font-weight: 500;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sub {
		overflow-wrap: anywhere;
	}
	.confirm {
		flex: none;
		position: relative;
	}
	.confirm summary {
		display: inline-flex;
		align-items: center;
		min-height: 30px;
		padding: 0 10px;
		border-radius: var(--radius-m);
		color: var(--danger);
		font-size: 13px;
		cursor: pointer;
		list-style: none;
	}
	.confirm form {
		position: absolute;
		right: 0;
		z-index: 2;
		display: grid;
		gap: 8px;
		width: min(240px, 70vw);
		padding: 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-m);
		background: var(--surface);
		box-shadow: var(--shadow-2);
	}
	.confirm p {
		margin: 0;
		font-size: 13px;
	}
	.upload {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: 13px;
	}
	.upload-name {
		flex: 1 1 120px;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.upload progress {
		flex: 1 1 120px;
		min-width: 0;
		accent-color: var(--accent);
	}
	.upload-error {
		color: var(--danger);
	}
	.upload-done {
		color: var(--success);
	}
	.upload-form {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 6px;
		padding: 12px;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius-l);
	}
	.upload-form.dragging {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.file-label {
		color: var(--muted);
		font-size: 13px;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.file {
		flex: 1 1 180px;
		width: 100%;
		min-width: 0;
		max-width: 100%;
		min-height: 36px;
		font: inherit;
		font-size: 16px;
	}
	@media (pointer: coarse) {
		.name {
			line-height: 44px;
		}
		.confirm summary,
		.file {
			min-height: 44px;
		}
	}
</style>
