/**
 * «Помощь с подключением» — the sender's numbers, in one place so the sender,
 * its statements, the status the operator reads and their specs cannot drift.
 */

/** Redis key the worker mirrors its last cycle into; the API's status reads it. */
export const CONNECT_HELP_LAST_RESULT_KEY = 'rezeis:connect-help:last-result';

/** Every ten minutes, in the worker only — the same beat as the probe. */
export const CONNECT_HELP_CRON = '*/10 * * * *';

/** At most this many subscriptions decided (or resumed) per cycle, oldest first. */
export const CONNECT_HELP_BATCH = 100;

/**
 * Of those, at most this many are claimed ladders being resumed, so the new
 * candidates always keep the rest. A resumed row costs at most the bot's 15 s
 * (a relay outage defers every one of them), so twenty take five of the eight
 * minutes at worst and new candidates still get three — rather than the
 * resumed rows, oldest first, eating the whole cycle every cycle.
 */
export const CONNECT_HELP_RESUME_CAP = 20;

/**
 * Throws after which a claimed ladder is given up as `skipped_failed`,
 * counted on the row across cycles: nothing may stay «В процессе» for ever
 * because one step keeps failing.
 */
export const CONNECT_HELP_MAX_FAILURES = 5;

/**
 * A push or e-mail step recorded as begun (`sending`) but never answered is
 * taken to be interrupted — the worker died mid-step — once it is this old:
 * one cron period, far longer than any step takes. Younger, it may belong to
 * another replica that is sending right now, and the row is left alone.
 */
export const CONNECT_HELP_STEP_STALE_MS = 10 * 60 * 1000;

/** The notice for a customer who PAID — the text may say «оплачена». */
export const CONNECT_HELP_TYPE = 'connect_help';

/** The notice for a trial or a gift — nothing was paid, and the text says so. */
export const CONNECT_HELP_TRIAL_TYPE = 'connect_help_trial';

/** `help_source` of the sender's own decisions. Broadcast staging writes `broadcast:<id>`. */
export const CONNECT_HELP_SOURCE_AUTO = 'auto';

/**
 * A second subscription of one person, decided within this long of a first
 * whose help went out (or is going out), is `merged`: one message per person
 * per day, however many subscriptions they bought.
 */
export const CONNECT_HELP_MERGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long, counted from `help_decided_at`, a claimed row whose ladder has not
 * finished — a bot step deferred by a relay outage — may wait for the panel to
 * answer. Past it, a row that still cannot be verified is closed as
 * `skipped_unverifiable`. Three deferrals take half an hour; the rest is room
 * for Remnawave or the worker being down.
 */
export const CONNECT_HELP_IN_FLIGHT_MS = 24 * 60 * 60 * 1000;

/**
 * A candidate whose moment lies within this long of the start of the window
 * is in its last cycles. If it is still unverified there, the window closes on
 * it: it is claimed as `skipped_unverifiable` and not asked about again. Two
 * cycles' worth, so one slow cycle cannot let a row slip out unrecorded.
 */
export const CONNECT_HELP_CLOSING_MS = 20 * 60 * 1000;

/**
 * A cycle stops taking up candidates after this long, so it ends before the
 * next tick. A relay that hangs costs up to 15 s per bot step; the candidates
 * left over are first in line next time — oldest first.
 */
export const CONNECT_HELP_CYCLE_BUDGET_MS = 8 * 60 * 1000;

/**
 * Slack on the index bound of a payment's creation: the anchor is its
 * fulfilment, which is never earlier than the creation and, for a payment
 * worth helping, not a day later.
 */
export const CONNECT_HELP_FULFILMENT_SLACK_MS = 24 * 60 * 60 * 1000;

/** The operator's log: rows per page, and the most one request may ask for. */
export const CONNECT_HELP_LOG_PAGE = 50;
export const CONNECT_HELP_LOG_MAX_PAGE = 100;
