import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

    // Every button on this card without an accessible name of its own is an
    // offer — the (i)s and the amber gap markers carry an `aria-label`, an offer
    // is named by its text — so the rendered set IS the offered set. Counted off
    // the template library rather than off a number written here, and asserted
    // exactly.
    const labels = screen
      .getAllByRole('button')
      .filter((button) => !button.hasAttribute('aria-label'))
      .map((button) => button.textContent ?? '');
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

/** The row of one trigger, found by its code. */
const rowOf = (type: string): HTMLElement => {
  const row = document.querySelector<HTMLElement>(`[data-trigger="${type}"]`);
  if (row === null) throw new Error(`no row for ${type}`);
  return row;
};

/** Hover an element and read the tooltip it opens. */
const tooltipOf = async (
  user: ReturnType<typeof userEvent.setup>,
  target: Element,
): Promise<string> => {
  await user.hover(target);
  const tip = await screen.findByRole('tooltip');
  return tip.textContent ?? '';
};

/** «Первое появление» on the Telegram sign-up — the owner's rule. */
const WELCOME_RULE = {
  ...RULE,
  id: 'rule-welcome',
  name: 'Первое появление',
  triggerSpec: 'user.registered',
  actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
};
const WELCOME_HINT = {
  ...HINT,
  id: 'hint-welcome',
  key: 'tpl-welcome',
  titleRu: 'Добро пожаловать',
  surfaces: ['browser'],
};

describe('the map says who a trigger is about and where they are', () => {
  beforeEach(async () => {
    await loadFeatureBundle('automations');
    vi.mocked(listRules).mockResolvedValue([RULE] as never);
    vi.mocked(listUserHints).mockResolvedValue([HINT] as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('names the event under its code, and invents no name for one the panel has no words for', async () => {
    // A legacy rule on an event no template covers still gets a row.
    vi.mocked(listRules).mockResolvedValue([
      RULE,
      { ...RULE, id: 'rule-legacy', triggerSpec: 'payment.refunded' },
    ] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);

    await waitFor(() => expect(screen.getByText('payment.failed')).toBeInTheDocument());
    expect(
      within(rowOf('payment.failed')).getByText(says('automationsPage.popupEvents.payment_failed')),
    ).toBeInTheDocument();
    expect(
      within(rowOf('user.web_registered')).getByText(
        says('automationsPage.popupEvents.user_web_registered'),
      ),
    ).toBeInTheDocument();
    // The legacy row carries its code and nothing dressed up as a name.
    const legacy = rowOf('payment.refunded');
    expect(legacy.querySelectorAll('p')).toHaveLength(0);
  });

  it("draws the amber marker on the owner's welcome, and drops it once Telegram is allowed", async () => {
    const user = userEvent.setup();
    vi.mocked(listRules).mockResolvedValue([WELCOME_RULE] as never);
    vi.mocked(listUserHints).mockResolvedValue([WELCOME_HINT] as never);

    const view = renderWithProviders(
      <TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />,
    );
    await waitFor(() => expect(screen.getByText('user.registered')).toBeInTheDocument());

    const row = rowOf('user.registered');
    // Still live: the marker is beside the state, never instead of it.
    expect(row.querySelector('[data-path-state]')?.getAttribute('data-path-state')).toBe('live');
    const marker = within(row).getByRole('button', {
      name: says('automationsPage.triggerMap.gapMarker'),
    });
    const tip = await tooltipOf(user, marker);
    expect(tip).toContain(
      says('automationsPage.triggerMap.gap', {
        home: says('userHints.reach.quoted', { value: says('userHints.surfaces.tma') }),
      }),
    );

    view.unmount();
    vi.mocked(listUserHints).mockResolvedValue([
      { ...WELCOME_HINT, surfaces: ['browser', 'tma'] },
    ] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('user.registered')).toBeInTheDocument());
    expect(
      within(rowOf('user.registered')).queryByRole('button', {
        name: says('automationsPage.triggerMap.gapMarker'),
      }),
    ).not.toBeInTheDocument();
  });

  it('opens the gap marker on a tap, the one sentence on the map that says where those customers are', async () => {
    // A plain Radix tooltip never opens on a tap and closes on a click, so on a
    // tablet the marker explained nothing.
    const user = userEvent.setup();
    vi.mocked(listRules).mockResolvedValue([WELCOME_RULE] as never);
    vi.mocked(listUserHints).mockResolvedValue([WELCOME_HINT] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('user.registered')).toBeInTheDocument());

    const marker = within(rowOf('user.registered')).getByRole('button', {
      name: says('automationsPage.triggerMap.gapMarker'),
    });
    await user.pointer({ keys: '[TouchA]', target: marker });

    expect((await screen.findByRole('tooltip')).textContent).toBe(
      says('automationsPage.triggerMap.gap', {
        home: says('userHints.reach.quoted', { value: says('userHints.surfaces.tma') }),
      }),
    );
  });

  it('draws a rule on an unchecked event amber, counts it apart from the failures, and says what is known', async () => {
    // An install from 0.9.7.48 holds rules like this, and so does any install
    // with a rule on an unlisted event that does name a customer. The map
    // cannot tell the two apart, so it neither greens nor reds them.
    const user = userEvent.setup();
    vi.mocked(listRules).mockResolvedValue([
      {
        ...RULE,
        id: 'rule-legacy',
        name: 'Обращение в поддержку',
        triggerSpec: 'support.ticket_created',
        actions: [{ type: 'show_hint', params: { hintKey: 'tpl-expire-soon' } }],
      },
    ] as never);
    vi.mocked(listUserHints).mockResolvedValue([
      { ...HINT, id: 'hint-2', key: 'tpl-expire-soon', titleRu: 'Скоро закончится' },
    ] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('support.ticket_created')).toBeInTheDocument());

    const path = rowOf('support.ticket_created').querySelector('[data-path-state]');
    expect(path?.getAttribute('data-path-state')).toBe('unverified');
    // Amber like the surface-gap marker, not the red of a certain failure.
    const chipClass = path!.closest('button')!.className;
    expect(chipClass).toMatch(/amber/);
    expect(chipClass).not.toMatch(/destructive/);
    expect(
      screen.getByText(says('automationsPage.triggerMap.counts.unverified', { count: 1 })),
    ).toBeInTheDocument();
    // Not a failure: the «Не сработает» badge stays away.
    expect(
      screen.queryByText(matchingAtAnyCount('automationsPage.triggerMap.counts.broken')),
    ).not.toBeInTheDocument();

    const tip = await tooltipOf(user, path!);
    expect(tip).toContain(says('automationsPage.triggerMap.pathUnverified'));
    expect(tip).not.toContain(says('automationsPage.triggerMap.pathLive'));
  });

  it('does not show the «Не проверено» badge when nothing is unchecked', async () => {
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('payment.failed')).toBeInTheDocument());

    expect(
      screen.queryByText(matchingAtAnyCount('automationsPage.triggerMap.counts.unverified')),
    ).not.toBeInTheDocument();
  });

  it('opens a chip explanation on a tap and on keyboard focus, not only on hover', async () => {
    // A Radix tooltip on a span never opened on a touch, so on a tablet the
    // reason a chip is red or amber could not be reached.
    const user = userEvent.setup();
    vi.mocked(listUserHints).mockResolvedValue([] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('payment.failed')).toBeInTheDocument());

    const chip = rowOf('payment.failed').querySelector('[data-path-state="missing-hint"]')!.closest('button')!;
    await user.pointer({ keys: '[TouchA]', target: chip });
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      says('automationsPage.triggerMap.pathMissingHint'),
    );
    await user.pointer({ keys: '[TouchA]', target: chip });
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

    // The taps left the chip focused; focus arriving afresh is the keyboard case.
    act(() => chip.blur());
    act(() => chip.focus());
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      says('automationsPage.triggerMap.pathMissingHint'),
    );
  });

  it('draws an audience action on an event rule red, with the reason', async () => {
    const user = userEvent.setup();
    vi.mocked(listRules).mockResolvedValue([
      {
        ...RULE,
        id: 'rule-audience',
        name: 'Рассылка на событии',
        actions: [{ type: 'show_hint_to_audience', params: { hintKey: 'tpl-payment-failed' } }],
      },
    ] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('payment.failed')).toBeInTheDocument());

    const path = rowOf('payment.failed').querySelector('[data-path-state="audience-on-event"]');
    expect(path).not.toBeNull();
    expect(screen.getByText(says('automationsPage.triggerMap.counts.broken', { count: 1 }))).toBeInTheDocument();
    expect(await tooltipOf(user, path!)).toContain(says('automationsPage.triggerMap.pathAudienceOnEvent'));
  });

  it('lists a scheduled show_hint rule where it can be pressed, and counts it', async () => {
    const user = userEvent.setup();
    vi.mocked(listRules).mockResolvedValue([
      { ...RULE, id: 'rule-cron', name: 'Ночная подсказка', triggerKind: 'CRON', triggerSpec: '0 3 * * *' },
    ] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('payment.failed')).toBeInTheDocument());

    const section = document.querySelector<HTMLElement>('[data-section="eventless-failures"]');
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain(says('automationsPage.triggerMap.eventlessTitle'));
    expect(screen.getByText(says('automationsPage.triggerMap.counts.broken', { count: 1 }))).toBeInTheDocument();

    const chip = section!.querySelector('[data-path-state="schedule-names-nobody"]')!.closest('button')!;
    await user.pointer({ keys: '[TouchA]', target: chip });
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      says('automationsPage.triggerMap.pathScheduleNamesNobody'),
    );
  });

  it('draws a chip for a wildcard whose hint was deleted, and does not call the rows it covers empty', async () => {
    // The header said «1 не сработает» while the only red thing on the map was
    // nowhere, and the covered rows said «плюс 1 правило по маске» and
    // «ничего не настроено» at the same time.
    const user = userEvent.setup();
    vi.mocked(listRules).mockResolvedValue([
      { ...RULE, id: 'rule-wild', name: 'Всё про оплату', triggerSpec: 'payment.*' },
    ] as never);
    vi.mocked(listUserHints).mockResolvedValue([] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('payment.*')).toBeInTheDocument());

    const chip = rowOf('payment.*').querySelector('[data-path-state="missing-hint"]');
    expect(chip).not.toBeNull();
    expect(
      screen.getByText(says('automationsPage.triggerMap.counts.broken', { count: 1 })),
    ).toBeInTheDocument();

    // The covered row explains itself with the cross-reference, and only that.
    const covered = rowOf('payment.failed');
    expect(covered.textContent).toContain(
      says('automationsPage.triggerMap.viaWildcard', { count: 1 }),
    );
    expect(covered.querySelectorAll('[data-path-state]')).toHaveLength(0);
    expect(await tooltipOf(user, chip!)).toContain(
      says('automationsPage.triggerMap.pathMissingHint'),
    );
  });

  it('shows on the chip and in its explanation that the rule is switched off', async () => {
    // «Кто увидит» has always carried the badge; the map left «Выключено» at 0
    // and drew the same amber chip as before the operator touched the switch.
    const user = userEvent.setup();
    vi.mocked(listRules).mockResolvedValue([
      {
        ...RULE,
        id: 'rule-legacy',
        name: 'Обращение в поддержку',
        triggerSpec: 'support.ticket_created',
        isEnabled: false,
      },
    ] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('support.ticket_created')).toBeInTheDocument());

    const chip = rowOf('support.ticket_created').querySelector('[data-path-state="unverified"]')!;
    expect(chip.textContent).toContain(says('automationsPage.triggerMap.ruleOff'));
    expect(chip.closest('button')!.getAttribute('aria-label')).toContain(
      says('automationsPage.triggerMap.ruleOff'),
    );
    expect(await tooltipOf(user, chip)).toContain(
      says('automationsPage.triggerMap.ruleOffNote'),
    );
  });

  it('says nothing about a switch on a chip whose state already is «выключено»', async () => {
    // Anti-vacuity: `paused` IS the switch, and repeating it would be noise.
    vi.mocked(listRules).mockResolvedValue([{ ...RULE, isEnabled: false }] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('payment.failed')).toBeInTheDocument());

    const chip = rowOf('payment.failed').querySelector('[data-path-state="paused"]')!;
    expect(chip.textContent).not.toContain(says('automationsPage.triggerMap.ruleOff'));
  });

  it('draws a switched-off hint as a failure, not in the amber of the unchecked', async () => {
    // They shared one style while being counted under different badges: one row
    // could show two identical amber chips beside «1 не сработает» and
    // «1 не проверено».
    vi.mocked(listRules).mockResolvedValue([
      RULE,
      {
        ...RULE,
        id: 'rule-unchecked',
        triggerSpec: 'support.ticket_created',
        actions: [{ type: 'show_hint', params: { hintKey: 'tpl-expire-soon' } }],
      },
    ] as never);
    vi.mocked(listUserHints).mockResolvedValue([
      { ...HINT, isActive: false },
      { ...HINT, id: 'hint-2', key: 'tpl-expire-soon', titleRu: 'Скоро закончится' },
    ] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('payment.failed')).toBeInTheDocument());

    const off = rowOf('payment.failed')
      .querySelector('[data-path-state="hint-inactive"]')!
      .closest('button')!.className;
    const unchecked = rowOf('support.ticket_created')
      .querySelector('[data-path-state="unverified"]')!
      .closest('button')!.className;
    expect(off).toMatch(/destructive/);
    expect(off).not.toMatch(/amber/);
    expect(unchecked).toMatch(/amber/);
    expect(off).not.toBe(unchecked);
  });

  it('lists an audience action with no audience among the rules with no event', async () => {
    const user = userEvent.setup();
    vi.mocked(listRules).mockResolvedValue([
      {
        ...RULE,
        id: 'rule-audience',
        name: 'Ночная рассылка',
        triggerKind: 'CRON',
        triggerSpec: '0 9 * * *',
        actions: [{ type: 'show_hint_to_audience', params: { hintKey: 'tpl-payment-failed' } }],
      },
    ] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('payment.failed')).toBeInTheDocument());

    const section = document.querySelector<HTMLElement>('[data-section="eventless-failures"]')!;
    expect(section).not.toBeNull();
    const chip = section.querySelector('[data-path-state="audience-invalid"]')!;
    expect(await tooltipOf(user, chip)).toContain(
      says('automationsPage.triggerMap.pathAudienceInvalid'),
    );
  });

  it('files a row the library has no stage for under «Прочее»', async () => {
    vi.mocked(listRules).mockResolvedValue([
      { ...RULE, id: 'rule-node', name: 'Все события нод', triggerSpec: 'node.*' },
    ] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('node.*')).toBeInTheDocument());

    expect(screen.getByText(says('automationsPage.hintTemplates.stages.other'))).toBeInTheDocument();
    expect(rowOf('node.*').closest('div.space-y-2')?.textContent).toContain(
      says('automationsPage.hintTemplates.stages.other'),
    );
  });

  it('draws a wildcard that reaches no checked event on a row of its own', async () => {
    vi.mocked(listRules).mockResolvedValue([
      { ...RULE, id: 'rule-node', name: 'Все события нод', triggerSpec: 'node.*' },
    ] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('node.*')).toBeInTheDocument());

    expect(rowOf('node.*').querySelector('[data-path-state="unverified"]')).not.toBeNull();
    expect(
      screen.getByText(says('automationsPage.triggerMap.counts.unverified', { count: 1 })),
    ).toBeInTheDocument();
  });

  it('says on hover what a path is and what its state means, instead of a native title', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />,
    );
    await waitFor(() => expect(screen.getByText('payment.failed')).toBeInTheDocument());

    // A native `title` opens for no keyboard and says nothing about meaning.
    expect(container.querySelector('[title]')).toBeNull();

    const path = rowOf('payment.failed').querySelector('[data-path-state]');
    expect(path).not.toBeNull();
    const tip = await tooltipOf(user, path!);
    expect(tip).toContain(
      says('automationsPage.triggerMap.pathRule', { rule: RULE.name, key: HINT.key }),
    );
    expect(tip).toContain(says('automationsPage.triggerMap.pathLive'));
  });

  it('says a path to a missing hint fails, not that it is live', async () => {
    const user = userEvent.setup();
    vi.mocked(listUserHints).mockResolvedValue([] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('payment.failed')).toBeInTheDocument());

    const path = rowOf('payment.failed').querySelector('[data-path-state="missing-hint"]');
    expect(path).not.toBeNull();
    const tip = await tooltipOf(user, path!);
    expect(tip).toContain(says('automationsPage.triggerMap.pathMissingHint'));
    expect(tip).not.toContain(says('automationsPage.triggerMap.pathLive'));
  });

  it('says what pressing an offer does, for each of its two branches', async () => {
    const user = userEvent.setup();
    vi.mocked(listUserHints).mockResolvedValue([
      { ...HINT, id: 'hint-2', key: 'tpl-expire-soon', titleRu: 'Скоро закончится' },
    ] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('remnawave.user.expire_soon')).toBeInTheDocument());

    const offers = within(rowOf('remnawave.user.expire_soon')).getAllByRole('button');
    const halfBuilt = offers.find((button) =>
      button.textContent?.includes(says('automationsPage.triggerMap.offerHalfBuilt')),
    );
    const fresh = offers.find(
      (button) =>
        button.textContent?.includes(templateName('expire_soon_quiet')) &&
        !button.textContent?.includes(says('automationsPage.triggerMap.offerHalfBuilt')),
    );
    expect(halfBuilt).toBeDefined();
    expect(fresh).toBeDefined();

    // Text already there: its stock words come back, the settings stay.
    expect(await tooltipOf(user, halfBuilt!)).toContain(
      says('automationsPage.triggerMap.offerHalfBuiltHint', { key: 'tpl-expire-soon' }),
    );
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

    // No text yet: it is created, and the draft rule opens.
    const quietKey = HINT_TEMPLATES.find((template) => template.id === 'expire_soon_quiet')!.hintKey;
    const freshTip = await tooltipOf(user, fresh!);
    expect(freshTip).toContain(says('automationsPage.triggerMap.offerNew', { key: quietKey }));
    expect(freshTip).not.toContain(
      says('automationsPage.triggerMap.offerHalfBuiltHint', { key: quietKey }),
    );
  });

  it('says a welcome offer applies its own door only', async () => {
    const user = userEvent.setup();
    vi.mocked(listUserHints).mockResolvedValue([] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('user.registered')).toBeInTheDocument());

    const [offer] = within(rowOf('user.registered')).getAllByRole('button');
    const tip = await tooltipOf(user, offer!);
    expect(tip).toContain(
      says('automationsPage.triggerMap.offerOneDoor', {
        event: says('automationsPage.popupEvents.user_registered'),
        other: says('automationsPage.popupEvents.user_web_registered'),
      }),
    );
  });

  it('keeps the tooltip of an offer reachable while it is disabled', async () => {
    const user = userEvent.setup();
    vi.mocked(listUserHints).mockResolvedValue([] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending />);
    await waitFor(() => expect(screen.getByText('payment.failed')).toBeInTheDocument());

    // The path chip is a button too (it opens its explanation); an offer is the
    // one named by its own text, with no `aria-label`.
    const offer = within(rowOf('payment.failed'))
      .getAllByRole('button')
      .find((button) => !button.hasAttribute('aria-label'))!;
    expect(offer).toBeDisabled();
    // The wrapper takes the hover a disabled button never receives.
    const wrapper = offer.parentElement!;
    expect(wrapper.tagName).toBe('SPAN');
    expect(wrapper.getAttribute('tabindex')).toBe('0');
    expect(await tooltipOf(user, wrapper)).toContain(
      says('automationsPage.triggerMap.offerNew', { key: 'tpl-payment-failed' }),
    );
  });

  it('keeps the explanations behind (i)s next to their headings, not as paragraphs', async () => {
    const user = userEvent.setup();
    vi.mocked(listUserHints).mockResolvedValue([
      { ...HINT, key: 'hand-written', titleRu: 'Своя подсказка' },
    ] as never);
    renderWithProviders(<TriggerMapCard onUseTemplate={() => undefined} templatePending={false} />);
    await waitFor(() => expect(screen.getByText('Своя подсказка')).toBeInTheDocument());

    const subtitle = says('automationsPage.triggerMap.subtitle');
    const orphansHint = says('automationsPage.triggerMap.orphansHint');
    expect(screen.queryByText(subtitle)).not.toBeInTheDocument();
    expect(screen.queryByText(orphansHint)).not.toBeInTheDocument();

    const aria = (subject: string) => says('automationsPage.infoAria', { subject });
    const titleInfo = screen.getByRole('button', {
      name: aria(says('automationsPage.triggerMap.title')),
    });
    expect(await tooltipOf(user, titleInfo)).toBe(subtitle);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

    const countsInfo = screen.getByRole('button', {
      name: aria(says('automationsPage.triggerMap.countsSubject')),
    });
    expect(await tooltipOf(user, countsInfo)).toBe(says('automationsPage.triggerMap.countsInfo'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

    // And by a tap, which a plain Radix tooltip never answers.
    const orphansInfo = screen.getByRole('button', {
      name: aria(says('automationsPage.triggerMap.orphans')),
    });
    await user.pointer({ keys: '[TouchA]', target: orphansInfo });
    expect((await screen.findByRole('tooltip')).textContent).toBe(orphansHint);
  });
});
