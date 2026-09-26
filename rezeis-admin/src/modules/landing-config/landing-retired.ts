/**
 * The web landing is retired (panel 0.9.7.71, cabinet 0.9.7.54)
 * ═══════════════════════════════════════════════════════════════
 * The owner's decision (26.09.2026): nothing replaces the landing. The builder
 * («Конфигурация» → «Веб-лендинг»), its admin API, the `landing_config`
 * permission and the `reiwa.landing.invalidate` hint are gone from this panel;
 * the cabinet 0.9.7.54 no longer has the page, its route or its caches.
 *
 * ONE ROUTE STAYS: `GET /api/internal/landing-config/effective`, which now
 * always answers {@link RETIRED_LANDING_ANSWER}. That is the "nothing
 * published" answer every cabinet since the landing existed already reads as
 * "`/` opens sign-in, no landing head":
 *
 *  - 0.9.7.53 keeps the landing it last read in memory AND in Redis with no
 *    TTL, and on any failure — a 404 included, since its transport throws on
 *    every non-2xx — it goes on serving that copy. A deleted route would have
 *    pinned the old landing on such a cabinet forever. A good answer with a
 *    boolean `enabled` is the only thing that replaces the Redis copy.
 *  - 0.9.7.52 keeps a memory copy for 60 s and reads this at the next expiry.
 *
 * The `landing` settings-version group stays too
 * (`bot-config/config-versions/config-version-sources.ts`), computed from this
 * constant. A panel that served a published landing therefore moves that
 * group's version exactly once, and a 0.9.7.53 still holding the landing
 * re-reads it at its next poll — memory and Redis — without waiting for a
 * visitor. A panel that had nothing published already answered this, so its
 * cabinets see no change.
 *
 * LIFETIME. The shim, the `landing` version group and its title in
 * `config-delivery-check.service.ts` leave together once
 * `CABINET_FLOOR_VERSION` (`reiwa-peers/cabinet-capabilities.ts`) passes
 * {@link LAST_LANDING_READER}: no supported cabinet reads the route then.
 * `test/landing-retired-shim.spec.ts` goes red at that point and says what to
 * delete.
 *
 * THE DATA STAYS. The operator's draft, the published revision and the history
 * remain in `landing_configs` and `landing_revisions` (models `LandingConfig`
 * and `LandingRevision` in `prisma/schema.prisma`), and backups keep dumping
 * them. Nothing in the panel reads or writes them any more; they are kept so
 * no operator loses content on an update, and so a rollback to 0.9.7.70 finds
 * its landing where it left it. `test/landing-data-kept.spec.ts` refuses any
 * later migration that drops, truncates or empties them.
 */

/** What the retired route answers: "no landing is published". */
export interface RetiredLandingAnswer {
  readonly enabled: false;
}

/**
 * The constant answer. `enabled` must stay a real boolean: 0.9.7.53 replaces
 * its Redis copy only with an object whose `enabled` is a boolean
 * (`LANDING_LKG.accepts` in reiwa's `last-known-good.ts` at v0.9.7.53), so
 * `{}` would leave the old landing in Redis to come back after a restart.
 */
export const RETIRED_LANDING_ANSWER: RetiredLandingAnswer = Object.freeze({ enabled: false });

/** The newest cabinet that still reads the landing route. Every later one never calls it. */
export const LAST_LANDING_READER = '0.9.7.53';
