import { runJobs } from '../../../src/lib/server/reminders/jobs';

/**
 * `ruby-jobs` (RB-09): the Cron Trigger (`* * * * *`) runs the reminder jobs against the app's D1. Relative imports:
 * the shared modules use no `#lib` alias, so the same files bundle here and in the app.
 *
 * The run's clock is the later of the trigger's scheduled time and the Worker's own clock. A real trigger is never
 * scheduled in the future, so in production that is `Date.now()`; a local run can pass a later `time` to Miniflare's
 * `/cdn-cgi/local/scheduled?cron=…&time=<ms>` route to simulate a future minute (e2e). Awaited, not `waitUntil`: the invocation ends with the work.
 */
export default {
	async scheduled(controller, env) {
		await runJobs(env, Math.max(Date.now(), controller.scheduledTime));
	},
	fetch() {
		return new Response('Not found', { status: 404 });
	}
} satisfies ExportedHandler<Env>;
