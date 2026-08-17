import { lookup } from 'node:dns';

import { Logger } from '@nestjs/common';

/**
 * Boot-time warning for cross-host URLs that still point at a docker service
 * name after the stack has been split across two VPSes.
 *
 * ── The problem ──────────────────────────────────────────────────────────────
 * `REIWA_URL` and `REZEIS_SUBPAGE_URL` default to docker service names
 * (`http://reiwa:5000`, `http://rezeis-subpage:3010`). That default is *correct*
 * on a single host, where those names are containers on the shared
 * `remnawave-network`, and *dead* on a split deploy, where they resolve to
 * nothing. Neither path fails loudly: the panel treats a non-empty URL as
 * "configured", so every push is attempted, fails DNS, and is dropped with one
 * warn line — the relay reports healthy while no notification ever arrives.
 *
 * ── Why this cannot be decided from the config alone ─────────────────────────
 * The process has no variable that says which topology it is in, and adding one
 * is not on the table (product settings live in the panel UI, and a new env var
 * would be one more thing to get wrong). A purely static rule — "warn when the
 * host has no dot" — would fire on every correct single-host install, which is
 * the worst possible outcome: an operator who learns to ignore this warning is
 * strictly worse off than one who never saw it.
 *
 * ── The signal actually used ─────────────────────────────────────────────────
 * DNS resolution of the hostname, from inside this process. It tests the thing
 * that matters rather than guessing the topology:
 *
 *   • correct single-host install — the peer is a container on the shared
 *     network, so its service name resolves. That is precisely what makes the
 *     install correct, so this check is silent by construction.
 *   • split-VPS install with the default left in place — the name does not
 *     exist here, resolution returns NXDOMAIN, and the warning fires.
 *
 * Four independent conditions must all hold before anything is printed, each
 * one removing a class of false positive:
 *
 *   1. `NODE_ENV === 'production'` — a developer running against a laptop is
 *      not who this is for.
 *   2. The hostname is *bare*: no dot, not an IP literal, not `localhost`. A
 *      real domain that is merely down is a different problem with a different
 *      fix, and this check says nothing about it.
 *   3. The feature is actually switched on (its shared secret is set). An
 *      install that does not use the reiwa relay at all is not misconfigured.
 *   4. The lookup fails with a definitive "no such name", and keeps failing
 *      across three attempts spread over five minutes. This absorbs the one
 *      real false positive: two independent compose stacks on the same host
 *      started minutes apart, where the peer container simply is not up yet.
 *      A transient resolver failure (EAI_AGAIN) is never reported.
 *
 * The check never blocks or fails the boot: refusing to start would break every
 * existing single-host install, and a warning that names the variable and the
 * consequence is what the operator needs anyway.
 */

/** Delay before each attempt, measured from the previous one (cumulative 30s / 2min / 5min). */
const PROBE_DELAYS_MS: readonly number[] = [30_000, 90_000, 180_000];

interface CrossHostTarget {
  /** The environment variable the operator would edit to fix this. */
  readonly variable: string;
  /** The effective value, including any default the consumers fall back to. */
  readonly value: string;
  /** What silently stops working while the name does not resolve. */
  readonly consequence: string;
}

/** Name resolution, injectable so the tests do not depend on real DNS. */
export type LookupFn = (
  hostname: string,
  callback: (error: NodeJS.ErrnoException | null) => void,
) => void;

/** Test seam only. Production calls pass nothing and get the real DNS + delays. */
export interface CrossHostCheckDeps {
  readonly lookup?: LookupFn;
  readonly delaysMs?: readonly number[];
}

/**
 * Schedules the probes and returns immediately. Safe to call unconditionally;
 * it no-ops outside production and can never throw into the boot path.
 */
export function warnOnUnreachableCrossHostUrls(
  logger: Logger = new Logger('CrossHostUrlCheck'),
  deps: CrossHostCheckDeps = {},
): void {
  try {
    if (process.env.NODE_ENV !== 'production') {
      return;
    }
    const resolveName = deps.lookup ?? defaultLookup;
    const delays = deps.delaysMs ?? PROBE_DELAYS_MS;
    for (const target of collectTargets()) {
      const hostname = bareServiceHostname(target.value);
      if (hostname === null) {
        continue;
      }
      scheduleProbe({ target, hostname, logger, resolveName, delays });
    }
  } catch {
    /* A diagnostic must never be the reason the panel fails to start. */
  }
}

/**
 * `lookup` (not `resolve`) on purpose: it goes through getaddrinfo, so it sees
 * docker's embedded DNS and /etc/hosts exactly the way the HTTP client will.
 */
const defaultLookup: LookupFn = (hostname, callback) => {
  lookup(hostname, (error) => callback(error));
};

/**
 * The cross-host URLs this process dials. Each is paired with the secret that
 * switches its feature on, so an install that deliberately does not use the
 * feature is never warned about a URL it will never dial.
 *
 * Deliberately NOT listed: `DATABASE_HOST`, `REDIS_HOST` and friends. Those name
 * containers in this stack's own compose file and stay docker service names on
 * both topologies, so a dotless value there is right, not suspicious.
 */
function collectTargets(): CrossHostTarget[] {
  const targets: CrossHostTarget[] = [];

  // Matches the fallback in BotNotifierClient / SystemHealthService /
  // UpdateCheckerService and the zod default in env.schema.ts: when the operator
  // sets nothing at all, `http://reiwa:5000` is what actually gets dialled, and
  // that unset case is the one most likely to be wrong on a split deploy.
  if (isSet(process.env.WEBHOOK_SECRET_HEADER)) {
    targets.push({
      variable: 'REIWA_URL',
      value: (process.env.REIWA_URL ?? '').trim() || 'http://reiwa:5000',
      consequence:
        'every push to the cabinet is dropped — bot-config cache busts, per-user Telegram ' +
        'notifications, broadcasts and backup delivery — while the panel keeps reporting the ' +
        'relay as configured and the reiwa card on the dashboard stays empty',
    });
  }

  if (isSet(process.env.REZEIS_SUBPAGE_URL) && isSet(process.env.REZEIS_SUBPAGE_WEBHOOK_SECRET)) {
    targets.push({
      variable: 'REZEIS_SUBPAGE_URL',
      value: (process.env.REZEIS_SUBPAGE_URL ?? '').trim(),
      consequence:
        'the subscription page never receives a config invalidate, so branding and catalog ' +
        'edits stay invisible there until its own TTL expires',
    });
  }

  return targets;
}

function isSet(value: string | undefined): boolean {
  return (value ?? '').trim().length > 0;
}

/**
 * Returns the hostname when it is a bare service name, `null` otherwise.
 *
 * A dot means a DNS name or an IPv4 literal; a colon or bracket means IPv6.
 * Both are things the operator addressed on purpose, and neither is the mistake
 * this check is looking for.
 */
function bareServiceHostname(value: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    // Not a parseable URL. The env schema already rejects that; this diagnostic
    // has nothing useful to add.
    return null;
  }
  if (hostname.length === 0) return null;
  if (hostname.includes('.') || hostname.includes(':') || hostname.includes('[')) return null;
  if (hostname.toLowerCase() === 'localhost') return null;
  return hostname;
}

function scheduleProbe(input: {
  readonly target: CrossHostTarget;
  readonly hostname: string;
  readonly logger: Logger;
  readonly resolveName: LookupFn;
  readonly delays: readonly number[];
}): void {
  const { target, hostname, logger, resolveName, delays } = input;
  const attempt = (index: number): void => {
    const timer = setTimeout(() => {
      resolveName(hostname, (error: NodeJS.ErrnoException | null) => {
        if (error === null || !isNameNotFound(error)) {
          // Either the name resolves — a correct single-host install, nothing to
          // say — or the resolver itself is unhappy. In neither case have we
          // learned that the value is wrong, so stay quiet and stop probing.
          return;
        }
        const next = index + 1;
        if (next < delays.length) {
          attempt(next);
          return;
        }
        logger.warn(
          `${target.variable}=${target.value} points at "${hostname}", a bare hostname that does ` +
            'not resolve from this host (DNS: no such name, still failing after 5 minutes). ' +
            'That is the single-host default, where it names a container on the shared docker ' +
            "network. On a split deploy it must be the peer's PUBLIC url " +
            `(https://<domain>). Until it is fixed, ${target.consequence}.`,
        );
      });
    }, delays[index]);
    // Never hold the process open for a diagnostic.
    timer.unref();
  };
  attempt(0);
}

/**
 * True only for a definitive "this name does not exist". `EAI_AGAIN` is a
 * temporary resolver failure and is deliberately excluded — reporting it would
 * turn a blip in docker's DNS into an accusation about the operator's config.
 */
function isNameNotFound(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOTFOUND' || error.code === 'ENODATA' || error.code === 'EAI_NODATA';
}
