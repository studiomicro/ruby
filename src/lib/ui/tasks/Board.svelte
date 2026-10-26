<!--
	Board: one column per status. Without JavaScript every card has a small "Move" form (status + top/bottom) that
	posts `?/move`. With JavaScript a card can also be dragged by its handle (pointer events) or moved with the
	keyboard (focus the handle, Space to lift, arrows to move, Enter to drop, Escape to cancel); the drop posts the
	same action with `afterTaskId` and is shown at once, then reverted with an error message if the server refuses.
	The board scrolls sideways inside its own box (one column per snap on a phone); the page never does.
	RB-08: `settings` renames columns, hides empty ones (a note links the tasks of a hidden column that has some) and
	shows a WIP chip (`4/3`, "Over limit" when above; moves are never refused); cards show label chips and steps.
-->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { deserialize, type SubmitFunction } from '$app/forms';
	import { enhance } from '#lib/ui/pwa/offline-form';
	import { invalidateAll } from '$app/navigation';
	import {
		TASK_STATUS_LABELS,
		type LabelColor,
		type TaskPriority,
		type TaskStatus
	} from '#lib/shared/enums';
	import Avatar from '#lib/ui/kit/Avatar.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Icon from '#lib/ui/kit/Icon.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import Due from './Due.svelte';
	import Priority from './Priority.svelte';
	import ChecklistProgress from '#lib/ui/pm/ChecklistProgress.svelte';
	import { bump, flip, markSaved, measure } from '#lib/ui/motion';
	import LabelChip from '#lib/ui/pm/LabelChip.svelte';

	type Card = {
		id: string;
		number: number;
		title: string;
		status: TaskStatus;
		priority: TaskPriority;
		assigneeId: string | null;
		assigneeName: string | null;
		dueOn: string | null;
		labels?: { id: string; name: string; color: LabelColor }[];
		checklist?: { done: number; total: number } | null;
	};
	type Column = { status: TaskStatus; count: number; tasks: Card[] };
	type Setting = {
		status: TaskStatus;
		label: string;
		wipLimit: number | null;
		hidden: boolean;
		taskCount: number;
	};

	let {
		board,
		projectKey,
		archived,
		today,
		moveAction,
		moreHref,
		settings = null
	}: {
		board: readonly Column[];
		projectKey: string;
		archived: boolean;
		today: string;
		/** The `?/move` URL with the current filters kept (the no-JS form re-renders this board). */
		moveAction: string;
		/** The list view filtered to one status (the "N more" link). */
		moreHref: (status: TaskStatus) => string;
		/** RB-08 column settings of the project (null: the defaults). */
		settings?: readonly Setting[] | null;
	} = $props();

	const settingOf = (status: TaskStatus) => settings?.find((s) => s.status === status);
	const labelOf = (status: TaskStatus) => settingOf(status)?.label ?? TASK_STATUS_LABELS[status];
	const hiddenSettings = $derived((settings ?? []).filter((s) => s.hidden));
	const statusOptions = $derived(
		board
			.filter((c) => !settingOf(c.status)?.hidden)
			.map((c) => ({ value: c.status, label: labelOf(c.status) }))
	);
	/** WIP state of a column: none, under, at or over its limit (by its live tasks, not the filtered count). */
	const wipOf = (status: TaskStatus) => {
		const s = settingOf(status);
		if (!s || s.wipLimit === null) return null;
		const state = s.taskCount > s.wipLimit ? 'over' : s.taskCount === s.wipLimit ? 'at' : 'under';
		return { count: s.taskCount, limit: s.wipLimit, state };
	};

	const PLACE_OPTIONS = [
		{ value: 'bottom', label: 'Bottom' },
		{ value: 'top', label: 'Top' }
	];

	// What the board shows: the server's columns, overridden by an optimistic move until the next load.
	let columns = $derived(
		board.filter((c) => !settingOf(c.status)?.hidden).map((c) => ({ ...c, tasks: [...c.tasks] }))
	);

	let mounted = $state(false);
	onMount(() => (mounted = true));

	/** The card being moved and where it would land (index among the target column's other cards). */
	type Drag = {
		taskId: string;
		from: TaskStatus;
		over: TaskStatus;
		index: number;
		mode: 'pointer' | 'keyboard';
		moved: boolean;
		startX: number;
		startY: number;
	};
	let drag = $state<Drag | null>(null);
	let announcement = $state('');
	let toast = $state<string | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	let busyId = $state<string | null>(null);
	let boardEl = $state<HTMLElement>();

	const others = (status: TaskStatus, taskId: string) =>
		columns.find((c) => c.status === status)?.tasks.filter((t) => t.id !== taskId) ?? [];
	/** The drag once it is really moving (a pointer that travelled, or a lifted keyboard card). */
	const shown = $derived(drag && (drag.moved || drag.mode === 'keyboard') ? drag : null);
	/** The card the drop marker sits above; null with a drag: the end of the column. */
	const markerBefore = $derived(
		shown ? (others(shown.over, shown.taskId)[shown.index]?.id ?? null) : undefined
	);

	const refOf = (id: string) => {
		for (const c of columns) {
			const t = c.tasks.find((x) => x.id === id);
			if (t) return `${projectKey}-${t.number}`;
		}
		return 'task';
	};
	const indexOf = (status: TaskStatus, taskId: string) =>
		columns.find((c) => c.status === status)?.tasks.findIndex((t) => t.id === taskId) ?? 0;

	function showToast(message: string) {
		toast = message;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 6000);
	}

	function describe(d: Drag) {
		const n = others(d.over, d.taskId).length + 1;
		return `${labelOf(d.over)}, position ${d.index + 1} of ${n}.`;
	}

	/** Applies the move locally, posts it, and reverts on refusal. */
	async function commit(d: Drag) {
		const target = others(d.over, d.taskId);
		const index = Math.max(0, Math.min(d.index, target.length));
		if (d.over === d.from && index === indexOf(d.from, d.taskId)) return;
		const afterTaskId = index === 0 ? '' : (target[index - 1]?.id ?? '');
		const snapshot = columns;
		const card = snapshot.flatMap((c) => c.tasks).find((t) => t.id === d.taskId);
		if (!card) return;
		// RB-20 Part B: every card glides from where it was (FLIP, also across columns); see #lib/ui/motion.
		const before = measure(boardEl, 'data-card');
		columns = snapshot.map((c) => {
			let tasks = c.tasks.filter((t) => t.id !== d.taskId);
			let count = c.count - (c.status === d.from ? 1 : 0);
			if (c.status === d.over) {
				tasks = [...tasks.slice(0, index), { ...card, status: d.over }, ...tasks.slice(index)];
				count += 1;
			}
			return { ...c, tasks, count };
		});
		busyId = d.taskId;
		await tick();
		flip(boardEl, 'data-card', before);
		const body = new FormData();
		body.set('taskId', d.taskId);
		body.set('status', d.over);
		body.set('afterTaskId', afterTaskId);
		try {
			const response = await fetch('?/move', {
				method: 'POST',
				body,
				headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
			});
			const result = deserialize(await response.text());
			if (result.type === 'success') {
				announcement = `Moved ${refOf(d.taskId)} to ${labelOf(d.over)}.`;
				const local = measure(boardEl, 'data-card');
				await invalidateAll();
				await tick();
				flip(boardEl, 'data-card', local);
				markSaved(boardEl?.querySelector(`[data-card="${d.taskId}"]`));
			} else {
				const moved = measure(boardEl, 'data-card');
				columns = snapshot;
				await tick();
				flip(boardEl, 'data-card', moved);
				const message =
					result.type === 'failure' && typeof result.data?.moveError === 'string'
						? result.data.moveError
						: 'The task could not be moved. Try again.';
				showToast(message);
			}
		} catch {
			const moved = measure(boardEl, 'data-card');
			columns = snapshot;
			await tick();
			flip(boardEl, 'data-card', moved);
			showToast('The task could not be moved. Check the connection and try again.');
		} finally {
			busyId = null;
		}
		await tick();
		boardEl?.querySelector<HTMLElement>(`[data-handle="${d.taskId}"]`)?.focus();
	}

	/** The phone and no-drag "Move" form: the same FLIP and highlight as a drag (RB-20 Part B). */
	const moveSubmit: SubmitFunction = ({ formData }) => {
		const before = measure(boardEl, 'data-card');
		const taskId = String(formData.get('taskId') ?? '');
		return async ({ update, result }) => {
			await update();
			await tick();
			flip(boardEl, 'data-card', before);
			if (result.type === 'success' || result.type === 'redirect')
				markSaved(boardEl?.querySelector(`[data-card="${CSS.escape(taskId)}"]`));
		};
	};

	// ── Pointer ─────────────────────────────────────────────────────────────────────────────────────────────

	function onPointerDown(event: PointerEvent, card: Card) {
		if (archived || event.button !== 0 || busyId) return;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		drag = {
			taskId: card.id,
			from: card.status,
			over: card.status,
			index: indexOf(card.status, card.id),
			mode: 'pointer',
			moved: false,
			startX: event.clientX,
			startY: event.clientY
		};
	}

	function onPointerMove(event: PointerEvent) {
		if (!drag || drag.mode !== 'pointer') return;
		if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6)
			return;
		drag.moved = true;
		// Keep the board and the page scrolling while the pointer is near an edge.
		if (boardEl) {
			const box = boardEl.getBoundingClientRect();
			if (event.clientX < box.left + 40) boardEl.scrollLeft -= 16;
			else if (event.clientX > box.right - 40) boardEl.scrollLeft += 16;
		}
		if (event.clientY < 60) window.scrollBy(0, -16);
		else if (event.clientY > window.innerHeight - 80) window.scrollBy(0, 16);

		const column = document
			.elementFromPoint(event.clientX, event.clientY)
			?.closest<HTMLElement>('[data-column]');
		const status = column?.dataset.column as TaskStatus | undefined;
		if (!column || !status) return;
		const cards = [...column.querySelectorAll<HTMLElement>('[data-card]')].filter(
			(el) => el.dataset.card !== drag?.taskId
		);
		let index = cards.length;
		for (let i = 0; i < cards.length; i++) {
			const box = cards[i]!.getBoundingClientRect();
			if (event.clientY < box.top + box.height / 2) {
				index = i;
				break;
			}
		}
		drag.over = status;
		drag.index = index;
	}

	function onPointerUp() {
		const d = drag;
		drag = null;
		if (d && d.mode === 'pointer' && d.moved) void commit(d);
	}

	// ── Keyboard ────────────────────────────────────────────────────────────────────────────────────────────

	function onHandleKey(event: KeyboardEvent, card: Card) {
		if (archived || busyId) return;
		const statuses = columns.map((c) => c.status);
		if (!drag || drag.mode !== 'keyboard') {
			if (event.key === ' ' || event.key === 'Enter') {
				event.preventDefault();
				drag = {
					taskId: card.id,
					from: card.status,
					over: card.status,
					index: indexOf(card.status, card.id),
					mode: 'keyboard',
					moved: false,
					startX: 0,
					startY: 0
				};
				announcement = `Lifted ${projectKey}-${card.number}. ${describe(drag)} Arrow keys move it, Enter drops it, Escape cancels.`;
			}
			return;
		}
		const d = drag;
		const count = others(d.over, d.taskId).length;
		const col = statuses.indexOf(d.over);
		switch (event.key) {
			case 'ArrowUp':
				d.index = Math.max(0, d.index - 1);
				break;
			case 'ArrowDown':
				d.index = Math.min(count, d.index + 1);
				break;
			case 'ArrowLeft':
			case 'ArrowRight': {
				const next = statuses[col + (event.key === 'ArrowLeft' ? -1 : 1)];
				if (!next) break;
				d.over = next;
				d.index = Math.min(d.index, others(next, d.taskId).length);
				boardEl
					?.querySelector(`[data-column="${next}"]`)
					?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
				break;
			}
			case 'Enter':
			case ' ':
				event.preventDefault();
				drag = null;
				void commit(d);
				return;
			case 'Escape':
				drag = null;
				announcement = 'Move cancelled.';
				return;
			default:
				return;
		}
		event.preventDefault();
		announcement = describe(d);
	}
</script>

<svelte:window
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={() => (drag = null)}
/>

{#if hiddenSettings.length > 0}
	<p class="hidden-note">
		{hiddenSettings.length}
		{hiddenSettings.length === 1 ? 'hidden column' : 'hidden columns'}.
		{#each hiddenSettings.filter((h) => h.taskCount > 0) as h (h.status)}
			<a href={moreHref(h.status)}
				>{h.taskCount} {h.taskCount === 1 ? 'task' : 'tasks'} hidden in {h.label}</a
			>
		{/each}
	</p>
{/if}

<div class="board" bind:this={boardEl} class:dragging={drag !== null}>
	{#each columns as column (column.status)}
		<section
			class="column"
			data-column={column.status}
			class:target={shown?.over === column.status}
			aria-labelledby="col-{column.status}"
		>
			<header class="column-head">
				<h2 id="col-{column.status}">
					<span class="col-name">{labelOf(column.status)}</span>
					<span class="count" aria-label="{column.count} tasks"
						>{#key column.count}<span class="num" in:bump|local>{column.count}</span>{/key}</span
					>
					{#if wipOf(column.status)}
						{@const wip = wipOf(column.status)!}
						<span
							class="wip {wip.state}"
							title="Work-in-progress limit {wip.limit}; never blocks a move."
							><span aria-hidden="true">{wip.count}/{wip.limit}</span><span class="sr-only"
								>{wip.count} of a limit of {wip.limit}</span
							>{#if wip.state === 'over'}
								Over limit{/if}</span
						>
					{/if}
				</h2>
				{#if !archived}
					<a
						class="add"
						href="/projects/{projectKey}/tasks/new?status={column.status}"
						aria-label="New task in {labelOf(column.status)}"
						title="New task"><Icon name="plus" size={16} /></a
					>
				{/if}
			</header>
			<ol class="cards">
				{#each column.tasks as card (card.id)}
					{#if shown?.over === column.status && markerBefore === card.id}
						<li class="marker" aria-hidden="true"></li>
					{/if}
					<li
						class="card"
						data-card={card.id}
						class:lifted={drag?.taskId === card.id}
						class:busy={busyId === card.id}
					>
						<div class="card-top">
							<span class="ref">{projectKey}-{card.number}</span>
							{#if mounted && !archived}
								<button
									type="button"
									class="handle"
									data-handle={card.id}
									aria-label="Move {projectKey}-{card.number}"
									aria-describedby="board-help"
									aria-pressed={drag?.taskId === card.id && drag.mode === 'keyboard'}
									onpointerdown={(e) => onPointerDown(e, card)}
									onkeydown={(e) => onHandleKey(e, card)}
									onblur={() => {
										if (drag?.mode === 'keyboard' && drag.taskId === card.id) drag = null;
									}}><span class="grip" aria-hidden="true">⋮⋮</span></button
								>
							{/if}
						</div>
						<a class="title" href="/projects/{projectKey}/tasks/{card.number}"
							><span class="title-text">{card.title}</span></a
						>
						{#if card.labels && card.labels.length > 0}
							<div class="labels">
								{#each card.labels as label (label.id)}<LabelChip
										name={label.name}
										color={label.color}
									/>{/each}
							</div>
						{/if}
						<div class="meta">
							<Priority priority={card.priority} compact />
							<ChecklistProgress progress={card.checklist ?? null} />
							<Due dueOn={card.dueOn} status={card.status} {today} empty="" />
							{#if card.assigneeId}
								<span class="who"
									><Avatar
										name={card.assigneeName ?? '?'}
										seed={card.assigneeId}
										size="sm"
										decorative={false}
									/></span
								>
							{/if}
						</div>
						{#if !archived}
							<details class="move">
								<summary>Move</summary>
								<form method="POST" action={moveAction} class="move-form" use:enhance={moveSubmit}>
									<input type="hidden" name="taskId" value={card.id} />
									<Select
										label="Status"
										name="status"
										options={statusOptions}
										value={card.status}
									/>
									<Select label="Place" name="place" options={PLACE_OPTIONS} value="bottom" />
									<Button type="submit" size="sm">Move</Button>
								</form>
							</details>
						{/if}
					</li>
				{/each}
				{#if shown?.over === column.status && markerBefore === null}
					<li class="marker" aria-hidden="true"></li>
				{/if}
				{#if column.tasks.length === 0 && shown?.over !== column.status}
					<li class="empty">No tasks</li>
				{/if}
			</ol>
			{#if column.count > column.tasks.length}
				<a class="more" href={moreHref(column.status)}
					>{column.count - column.tasks.length} more — open list view with this status</a
				>
			{/if}
		</section>
	{/each}
</div>

<p id="board-help" class="sr-only">
	Press Space to lift the card, arrow keys to move it, Enter to drop it and Escape to cancel.
</p>
<p class="sr-only" role="status" aria-live="polite">{announcement}</p>
{#if toast}
	<div class="toast" role="alert">
		<span>{toast}</span>
		<button type="button" class="toast-close" aria-label="Dismiss" onclick={() => (toast = null)}
			><Icon name="close" size={16} /></button
		>
	</div>
{/if}

<style>
	.board {
		display: flex;
		gap: 12px;
		max-width: 100%;
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scroll-snap-type: x mandatory;
		scroll-padding-inline: 2px;
		padding: 2px 2px 12px;
		-webkit-overflow-scrolling: touch;
	}
	.board.dragging {
		scroll-snap-type: none;
		user-select: none;
	}
	.column {
		display: flex;
		flex-direction: column;
		flex: 0 0 min(280px, calc(100vw - 56px));
		min-width: 0;
		padding: 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface-2);
		scroll-snap-align: start;
	}
	.column.target {
		border-color: var(--accent);
	}
	/* RB-20 Part B: the drop target lights up (colour only, no layout change); the count bump needs a box to scale. */
	.column {
		transition: border-color var(--dur-fast) var(--ease);
	}
	.num {
		display: inline-block;
	}
	.column-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 8px;
	}
	h2 {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		font-size: 13px;
		font-weight: 600;
	}
	.col-name {
		overflow-wrap: anywhere;
	}
	.wip {
		padding: 0 6px;
		border-radius: 999px;
		background: var(--surface-3);
		color: var(--muted);
		font-size: 12px;
		font-weight: 500;
		line-height: 20px;
		white-space: nowrap;
	}
	.wip.at {
		background: var(--warning-soft);
		color: var(--warning);
	}
	.wip.over {
		background: var(--danger-soft);
		color: var(--danger);
	}
	.labels {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		min-width: 0;
	}
	.hidden-note {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		margin: 0 0 10px;
		color: var(--muted);
		font-size: 13px;
	}
	.hidden-note a {
		display: inline-flex;
		align-items: center;
		color: var(--accent);
	}
	@media (pointer: coarse) {
		.hidden-note a {
			min-height: 44px;
		}
	}
	.count {
		min-width: 20px;
		padding: 0 6px;
		border-radius: 999px;
		background: var(--surface-3);
		color: var(--muted);
		font-size: 12px;
		line-height: 20px;
		text-align: center;
	}
	.add {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-m);
		color: var(--muted);
	}
	.add:hover {
		background: var(--surface-3);
		color: var(--fg);
	}
	@media (pointer: coarse) {
		.add {
			width: 44px;
			height: 44px;
		}
	}
	.cards {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
		min-height: 40px;
	}
	.card {
		display: grid;
		gap: 6px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		background: var(--surface);
		box-shadow: var(--shadow-1);
		min-width: 0;
	}
	.card.lifted {
		opacity: 0.45;
		outline: 2px dashed var(--accent);
		outline-offset: 1px;
	}
	.card.busy {
		opacity: 0.7;
	}
	.card-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 20px;
	}
	.ref {
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.handle {
		display: grid;
		place-items: center;
		width: 32px;
		height: 28px;
		margin: -4px -6px -4px 0;
		border: 0;
		border-radius: var(--radius-s);
		background: none;
		color: var(--subtle);
		cursor: grab;
		touch-action: none;
	}
	.handle:hover,
	.handle[aria-pressed='true'] {
		background: var(--surface-2);
		color: var(--fg);
	}
	@media (pointer: coarse) {
		.handle {
			width: 44px;
			height: 44px;
			margin: -10px -12px -10px 0;
		}
	}
	.grip {
		font-size: 14px;
		letter-spacing: -3px;
		line-height: 1;
	}
	/* The link is the tap target (≥ 44 px on touch); the text inside it is clamped to two lines. */
	.title {
		display: flex;
		align-items: center;
		min-width: 0;
		color: var(--fg);
		text-decoration: none;
	}
	@media (pointer: coarse) {
		.title {
			min-height: 44px;
		}
	}
	.title-text {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		font-size: 14px;
		font-weight: 500;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}
	.title:hover .title-text {
		text-decoration: underline;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		min-height: 22px;
	}
	.who {
		margin-left: auto;
	}
	.move summary {
		display: inline-flex;
		align-items: center;
		min-height: 28px;
		color: var(--muted);
		font-size: 12px;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		.move summary {
			min-height: 44px;
		}
	}
	.move-form {
		display: grid;
		gap: 8px;
		margin-top: 6px;
	}
	.marker {
		height: 3px;
		border-radius: 2px;
		background: var(--accent);
	}
	.empty {
		padding: 10px 4px;
		color: var(--subtle);
		font-size: 13px;
	}
	.more {
		margin-top: 10px;
		color: var(--accent);
		font-size: 13px;
	}
	.toast {
		position: fixed;
		z-index: 45;
		left: max(16px, var(--sai-left));
		right: max(16px, var(--sai-right));
		bottom: calc(var(--tabbar-h) + var(--sai-bottom) + 12px);
		display: flex;
		align-items: center;
		gap: 10px;
		max-width: 480px;
		margin: 0 auto;
		padding: 10px 12px;
		border-radius: var(--radius-m);
		background: var(--danger-soft);
		color: var(--danger);
		box-shadow: var(--shadow-2);
		font-size: 14px;
	}
	@media (min-width: 768px) {
		.toast {
			bottom: calc(24px + var(--sai-bottom));
		}
	}
	.toast-close {
		display: grid;
		place-items: center;
		margin-left: auto;
		width: 32px;
		height: 32px;
		border: 0;
		border-radius: var(--radius-s);
		background: none;
		color: inherit;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		.toast-close {
			width: 44px;
			height: 44px;
		}
	}
</style>
