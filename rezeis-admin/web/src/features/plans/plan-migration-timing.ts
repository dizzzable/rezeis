/**
 * THE CLOCKS OF THE DELETE DIALOG'S MIGRATION STEPS.
 *
 * A module of their own, and for one reason: a page spec has to run a move from
 * start to delete in milliseconds, and a constant read inside the module that
 * declares it cannot be replaced from outside. Kept here, `vi.mock` shortens
 * them for `plans-page-delete.test.tsx`, while `plan-migration.test.ts` pins the
 * values an operator actually gets — so a shortened clock can never leak into
 * the product unnoticed.
 */

/**
 * How often a running move is polled: every 2–3 s (spec §7.5). Polling stops
 * by itself once the server reports the run finished.
 */
export const PLAN_MIGRATION_POLL_MS = 2_500

/** How long the search box waits after the last keystroke before it asks the server. */
export const PLAN_MIGRATION_SEARCH_DEBOUNCE_MS = 300

/**
 * How long the success state stays on screen before the plan is re-checked and
 * deleted. The operator is owed the sight of "everything moved" before the
 * dialog closes on its own; a delete that followed the last poll instantly
 * would read as the dialog vanishing mid-move.
 */
export const PLAN_MIGRATION_SUCCESS_HOLD_MS = 1_400

/**
 * How long after an ACCEPTED retry a finished status is still not taken as the
 * answer. The retry endpoint answers 202 and re-drives the work in the
 * background, so the first poll after it can still carry the run as it was
 * BEFORE the retry — finished, with the old failures. Reading that as the
 * result would show the operator the same problems again, as if the retry had
 * done nothing. Inside this window the dialog keeps polling and keeps showing
 * the synchronisation state; a run the retry really restarted reports itself
 * unfinished long before it closes.
 */
export const PLAN_MIGRATION_RETRY_ECHO_MS = 6_000
