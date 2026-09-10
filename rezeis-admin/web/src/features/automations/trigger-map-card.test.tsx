import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';

import { i18n, loadFeatureBundle } from '@/i18n/i18n';
import { renderWithProviders } from '@/test/test-utils';
import { TriggerMapCard } from './trigger-map-card';
import { HINT_TEMPLATES } from './hint-templates';
import { listRules } from './automations-api';
import { listUserHints } from '@/features/user-hints/user-hints-api';
import { en } from '@/i18n/features/automations.en';

/** A template's operator-facing name, from the bundle the harness renders in. */
const templateName = (id: string): string => {
  const bundle = en as unknown as {
    automationsPage: { hintTemplates: Record<string, { name: string }> };
  };
  const template = bundle.automationsPage.hintTemplates[id];
  if (template === undefined) throw new Error(`no copy for template "${id}"`);
  return template.name;
};

/**
 * The sentence a key renders right now — looked up, never restated.
 *
 * Every string used to FIND something on this card is a locator and not a claim
 * about wording: which lane heading, which badge, which label on an offer. They
 * were typed out here, which costs twice. A copy correction turns the positive
 * cases red for a reason they have nothing to do with — and the two NEGATIVE
 * ones, `queryByText(/will not fire/)` and `queryByText(/text ready, no rule/)`,
 * would have stopped guarding in silence: a matcher for a sentence the bundle no
 * longer contains finds nothing whether the badge is correctly hidden or the
 * words simply moved. That is the shape that already cost this feature a case in
 * `trigger-catalog-hint.test.tsx`.
 *
 * `not.toBe(key)` is the other half. i18next answers a miss with the key path,
 * so a renamed key would otherwise build a matcher out of
 * `automationsPage.triggerMap...` — which matches nothing, and passes every
 * negative just as quietly.
 */
const says = (key: string, values?: Record<string, unknown>): string => {
  const sentence = String(i18n.t(key, values ?? {}));
  expect(sentence, `${key} is missing from the automations bundle`).not.toBe(key);
  return sentence;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A locator built from a key, for an element whose text merely CONTAINS it. */
const matching = (key: string, values?: Record<string, unknown>): RegExp =>
  new RegExp(escapeRegExp(says(key, values)));

/**
 * The copy for a counted key, with the number itself left free.
 *
 * A negative case needs this and `says(key, { count: 0 })` will not do. The
 * badge's job is to be ABSENT, not to be zero: pinning the sentence at one count
 * would go quiet again the moment a regression rendered it carrying any other
 * number. The sentinel is asserted to survive interpolation, so a key that stops
 * taking a count fails here rather than producing a pattern that matches
 * nothing.
 */
const matchingAtAnyCount = (key: string): RegExp => {
  const SENTINEL = '987654';
  const sentence = says(key, { count: Number(SENTINEL) });
  expect(sentence, `${key} no longer carries its count`).toContain(SENTINEL);
  return new RegExp(sentence.split(SENTINEL).map(escapeRegExp).join('\\d+'));
};

vi.mock('./automations-api', () => ({ listRules: vi.fn() }));
vi.mock('@/features/user-hints/user-hints-api', () => ({ listUserHints: vi.fn() }));

/**
 * The map, on screen.
 *
 * `trigger-map.test.ts` proves the join; this proves an operator can SEE it.
 * The two are worth separating because the failure modes differ: the join can
 * be right while the card renders the state nowhere, and a card that throws
 * takes the tab down without any of the pure cases going red.
 *
 * The case that matters most is the broken path. Its whole reason for existing
 * is that a rule naming a hint nobody wrote is invisible in both other tabs —
 * so if this view does not say so out loud, the view is pointless.
 */

const RULE = {
  id: 'rule-1',
  name: 'Оплата не прошла',
  description: null,
  isEnabled: true,
  triggerKind: 'REALTIME' as const,
  triggerSpec: 'payment.failed',
  conditions: null,
  actions: [{ type: 'show_hint', params: { hintKey: 'tpl-payment-failed' } }],
  createdById: null,
  lastRunAt: null,
  lastRunStatus: null,
  lastRunMessage: null,
  runCount: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const HINT = {
  id: 'hint-1',
  key: 'tpl-payment-failed',
  titleRu: 'Оплата не прошла',
  bodyRu: 'Текст',
  titleEn: null,
  bodyEn: null,
  mode: 'MODAL',
  tone: 'WARNING',
  ctaKind: 'NONE',
  ctaLabelRu: null,
  ctaLabelEn: null,
  ctaTarget: null,
  surfaces: [],
  formFactors: [],
  groupKey: null,
  ttlHours: 24,
  isRepeatable: true,
  isActive: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

describe('the trigger map on screen', () => {
  beforeEach(async () => {
    await loadFeatureBundle('automations');
    vi.mocked(listRules).mockResolvedValue([RULE] as never);
    vi.mocked(listUserHints).mockResolvedValue([HINT] as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // The harness renders in English; the copy asserted below is the English
  // bundle's, which is also the half a parity guard cannot check for meaning.
  it('draws a lane per stage and a row per trigger', async () => {
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);

    // The trigger is shown verbatim, because it is what the operator types into
    // the rule editor — a friendly name here would not help them find it there.
    await waitFor(() => expect(screen.getByText('payment.failed')).toBeInTheDocument());
    expect(screen.getByText('remnawave.user.expire_soon')).toBeInTheDocument();
    // A stage heading, so the rows read as a journey rather than a dump.
    expect(
      screen.getByText(says('automationsPage.hintTemplates.stages.retention')),
    ).toBeInTheDocument();
  });

  it('names the missing hint when a rule points at nothing', async () => {
    // THE CASE THE VIEW EXISTS FOR. Both other tabs look healthy: the rule is
    // enabled, and the hints tab simply has one fewer row than somebody thought.
    vi.mocked(listUserHints).mockResolvedValue([] as never);

    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);

    await waitFor(() =>
      expect(screen.getByText(/tpl-payment-failed/)).toBeInTheDocument(),
    );
    // And the count says it at the top, so it is visible without reading rows.
    // At ONE, because one rule points at nothing here: the badge saying "17"
    // for a single mistake is a defect this feature has already shipped once.
    expect(
      screen.getByText(says('automationsPage.triggerMap.counts.broken', { count: 1 })),
    ).toBeInTheDocument();
  });

  it('does not shout when nothing is broken', async () => {
    // The broken badge is hidden at zero rather than shown in green: a warning
    // colour that is always on screen is a warning colour nobody reads.
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);

    await waitFor(() => expect(screen.getByText('payment.failed')).toBeInTheDocument());
    expect(
      screen.queryByText(matchingAtAnyCount('automationsPage.triggerMap.counts.broken')),
    ).not.toBeInTheDocument();
  });

  it('offers every ready-made pop-up whose trigger has none, and none beside a live path', async () => {
    // THE NAME USED TO PROMISE ONLY THE FIRST HALF and the assertions checked
    // only the second. What stood in for "a bare trigger still gets its button"
    // was `labels.length > 1` — a count of every button anywhere on the card,
    // which is satisfied by two buttons on any two rows. Offering only the
    // FIRST template per trigger, for instance, silently drops the second half
    // of all four alternative pairs from the map and passed that check.
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);

    // `payment.failed` has a live rule, so nothing is offered on that row:
    // offering the alternative beside a live path is an invitation to two
    // pop-ups for one act, which is what the collision panel warns about. Every
    // other trigger is bare and keeps its buttons.
    await waitFor(() => expect(screen.getByText('payment.failed')).toBeInTheDocument());

    // Every button on this card is an offer, so the rendered set IS the offered
    // set. Counted off the template library rather than off a number written
    // here, and asserted exactly.
    const labels = screen.getAllByRole('button').map((button) => button.textContent ?? '');
    const expected = HINT_TEMPLATES.filter(
      (template) => template.triggerSpec !== RULE.triggerSpec,
    );

    expect(
      HINT_TEMPLATES.length - expected.length,
      'nothing is on the live trigger, so the suppression half proves nothing',
    ).toBeGreaterThan(1);
    expect(labels).toHaveLength(expected.length);

    // Named as well as counted, so a failure says WHICH row broke rather than
    // only that a number moved. Read out of the bundle rather than typed in:
    // pinning the words themselves makes this fail on a copy edit.
    const suppressed = templateName('payment_failed_method');
    expect(
      labels.some((label) => label.includes(suppressed)),
      'the alternative was offered beside a live path',
    ).toBe(false);
    const offered = templateName('expire_soon');
    expect(
      labels.some((label) => label.includes(offered)),
      'a bare trigger lost its button',
    ).toBe(true);
  });

  it('admits when the text of an offered pop-up already exists', async () => {
    // A TEMPLATE APPLIED AND THEN ABANDONED. The hint row is written before
    // the rule — deliberately, so a rule never names a key that does not
    // exist — and the rule opens as a draft the operator still has to press
    // Create on. Walk away there and the text sits on the Hints tab firing
    // for nobody.
    //
    // The map is the one screen that could say so, `hintExists` had been
    // computed for it since the first commit, and the button rendered exactly
    // like a template nobody had ever touched.
    vi.mocked(listUserHints).mockResolvedValue([
      { ...HINT, id: 'hint-2', key: 'tpl-expire-soon', titleRu: 'Скоро закончится' },
    ] as never);

    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);

    await waitFor(() => expect(screen.getByText('remnawave.user.expire_soon')).toBeInTheDocument());

    // EXACTLY ONE, and on the button whose text was written. "At least one
    // element says it" is satisfied by a label printed on every offer, which is
    // precisely the regression the case below exists to forbid — so the two
    // cases together used to leave a whole branch uncovered. One hint row is
    // seeded, so one badge is the whole truth about this fixture.
    const halfBuilt = screen.getAllByText(matching('automationsPage.triggerMap.offerHalfBuilt'));
    expect(halfBuilt).toHaveLength(1);

    // Both halves, because one of these names CONTAINS the other: the quiet
    // alternative is "Subscription ending soon — quietly", so a `toContain` for
    // the modal's name alone is satisfied by the badge sitting on the wrong one
    // of the pair — and the pair is exactly what shares this trigger.
    const button = halfBuilt[0]!.closest('button');
    expect(button?.textContent).toContain(templateName('expire_soon'));
    expect(button?.textContent).not.toContain(templateName('expire_soon_quiet'));
  });

  it('says nothing of the sort about a template nobody has applied', async () => {
    // Anti-vacuity: a label printed on every offer says nothing at all.
    vi.mocked(listUserHints).mockResolvedValue([] as never);

    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);

    await waitFor(() => expect(screen.getByText('remnawave.user.expire_soon')).toBeInTheDocument());
    expect(
      screen.queryByText(matching('automationsPage.triggerMap.offerHalfBuilt')),
    ).not.toBeInTheDocument();
  });
  it('lists a hint nothing points at', async () => {
    vi.mocked(listUserHints).mockResolvedValue([
      { ...HINT, key: 'hand-written', titleRu: 'Своя подсказка' },
    ] as never);

    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);

    await waitFor(() => expect(screen.getByText('Своя подсказка')).toBeInTheDocument());
  });
});
