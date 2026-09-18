import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Check,
  CircleHelp,
  EyeOff,
  Filter,
  MapPinOff,
  Pause,
  Plus,
  PowerOff,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTip } from '@/components/ui/info-tip';
import { Skeleton } from '@/components/ui/skeleton';
import { ActionTip } from '@/features/user-hints/action-tip';
import { surfaceNames } from '@/features/user-hints/surface-names';
import { listUserHints } from '@/features/user-hints/user-hints-api';

import { listRules } from './automations-api';
import {
  ARRIVAL_TEMPLATE_IDS,
  HINT_TEMPLATES,
  isArrivalTemplate,
  type HintTemplate,
} from './hint-templates';
import { popupEventName } from './popup-audience';
import {
  buildTriggerMap,
  type EventlessFailureReason,
  type TriggerPathState,
} from './trigger-map';

/**
 * The map: every trigger, and what stands between it and a customer's screen.
 *
 * ── The gap it fills ─────────────────────────────────────────────────────────
 *
 * A pop-up is two rows in two tables joined by a string. The rules tab shows
 * one row, the hints tab shows the other, and until this view existed nothing
 * showed the JOIN — so both ways the subsystem fails were invisible in the two
 * places an operator looks. A rule naming a hint nobody wrote fails once per
 * firing, in an execution log, while reading "enabled" in the list; a hint
 * nothing points at fails by never being mentioned at all.
 *
 * ── Why lanes and not a graph ────────────────────────────────────────────────
 *
 * A drawn graph of seventeen triggers is a picture an operator admires and
 * cannot act on. What they actually arrive with is a moment — "somebody's
 * subscription is about to run out and I want to say something" — so the map is
 * ordered by the customer's life and every row is a place to press a button.
 * The arrow between the two halves of a row is the string that was invisible.
 *
 * ── Why the explanations are behind (i)s and tooltips ────────────────────────
 *
 * Visible text is the live state; how to read it is one hover away. The native
 * `title=` tooltips this card used never open on keyboard focus and say nothing
 * about what a state MEANS or what a press DOES, which is what an operator
 * standing in front of a red badge needs.
 */

/**
 * What a chip on the map can say: a path's state, or a scheduled `show_hint`
 * rule, which has no event row and fails on every run.
 */
type ChipState = TriggerPathState | EventlessFailureReason;

const STATE_STYLE: Record<ChipState, string> = {
  live: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  paused: 'border-muted-foreground/30 bg-muted text-muted-foreground',
  'missing-hint': 'border-destructive/50 bg-destructive/10 text-destructive',
  // Counted under «Не сработает», so drawn as a failure: the hint is switched
  // off and the rule queues nothing. It shared the amber of `unverified` while
  // being counted red, so one row could show two identical chips beside
  // «1 не сработает» and «1 не проверено» with only a 12px icon between them.
  'hint-inactive': 'border-destructive/50 bg-destructive/10 text-destructive',
  // Uncertain, not broken — the one meaning amber carries on this card, and
  // the same amber as the surface-gap marker.
  unverified: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  'audience-on-event': 'border-destructive/50 bg-destructive/10 text-destructive',
  'schedule-names-nobody': 'border-destructive/50 bg-destructive/10 text-destructive',
  'audience-invalid': 'border-destructive/50 bg-destructive/10 text-destructive',
};

const STATE_ICON: Record<ChipState, typeof Check> = {
  live: Check,
  paused: Pause,
  'missing-hint': AlertTriangle,
  'hint-inactive': EyeOff,
  unverified: CircleHelp,
  'audience-on-event': Ban,
  'schedule-names-nobody': Ban,
  'audience-invalid': Ban,
};

/** What each state means, for the explanation behind a chip. */
const STATE_MEANING: Record<ChipState, string> = {
  live: 'automationsPage.triggerMap.pathLive',
  paused: 'automationsPage.triggerMap.pathPaused',
  'missing-hint': 'automationsPage.triggerMap.pathMissingHint',
  'hint-inactive': 'automationsPage.triggerMap.pathHintInactive',
  unverified: 'automationsPage.triggerMap.pathUnverified',
  'audience-on-event': 'automationsPage.triggerMap.pathAudienceOnEvent',
  'schedule-names-nobody': 'automationsPage.triggerMap.pathScheduleNamesNobody',
  'audience-invalid': 'automationsPage.triggerMap.pathAudienceInvalid',
};

/**
 * One rule → hint chip, explained behind the same press as an (i): hover,
 * keyboard focus AND a tap.
 *
 * It was a Radix tooltip on a focusable span, which never opens on a touch —
 * so on a tablet the one sentence saying why a chip is red or amber could not
 * be reached. `InfoTip` is that press behaviour already, tested; the chip is
 * what it draws in place of the (i).
 */
function PathChip({
  state,
  title,
  label,
  hasConditions,
  isEnabled,
  offLabel,
  children,
}: {
  readonly state: ChipState;
  /** What the chip shows: the hint's title, or that there is no such hint. */
  readonly title: string;
  /** The accessible name — begins with `title`, so what is read is what is seen. */
  readonly label: string;
  readonly hasConditions: boolean;
  /** The rule's own switch. `paused` says it by being that state. */
  readonly isEnabled: boolean;
  /** The words for a switched-off rule, drawn beside every other state. */
  readonly offLabel: string;
  /** The explanation. */
  readonly children: ReactNode;
}) {
  const Icon = STATE_ICON[state];
  // `paused` IS "switched off"; every other state hid it, so a rule just
  // switched off looked exactly as it did a moment before.
  const showOff = !isEnabled && state !== 'paused';
  return (
    <InfoTip
      label={label}
      className={`max-w-full shrink rounded-md border px-1.5 py-0.5 text-[11px] hover:text-inherit ${STATE_STYLE[state]}`}
      icon={
        <span data-path-state={state} className="inline-flex min-w-0 max-w-full items-center gap-1">
          <Icon className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{title}</span>
          {hasConditions && (
            // Green means "customers are seeing this", and a rule with
            // conditions may be reaching four people or none — the map cannot
            // tell, and the explanation behind the chip says so.
            <Filter className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
          )}
          {showOff && (
            <span className="inline-flex shrink-0 items-center gap-0.5 opacity-70">
              <PowerOff className="h-3 w-3" aria-hidden />
              {offLabel}
            </span>
          )}
        </span>
      }
    >
      {children}
    </InfoTip>
  );
}

export function TriggerMapCard({
  onUseTemplate,
  templatePending,
}: {
  readonly onUseTemplate: (template: HintTemplate) => void;
  readonly templatePending: boolean;
}) {
  const { t } = useTranslation();
  // The same query keys the rest of the page uses, so this shares its cache and
  // an edit made in either tab is reflected here without a refetch of its own.
  const rulesQuery = useQuery({ queryKey: ['admin', 'automations', 'rules'], queryFn: listRules });
  const hintsQuery = useQuery({ queryKey: ['admin', 'user-hints'], queryFn: listUserHints });

  if (rulesQuery.isLoading || hintsQuery.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (rulesQuery.error || hintsQuery.error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t('automationsPage.errors.title')}</AlertTitle>
        <AlertDescription>{t('automationsPage.triggerMap.loadFailed')}</AlertDescription>
      </Alert>
    );
  }

  const map = buildTriggerMap({
    rules: rulesQuery.data ?? [],
    hints: hintsQuery.data ?? [],
  });
  const templateById = new Map(HINT_TEMPLATES.map((template) => [template.id, template]));
  const infoAria = (subject: string): string => t('automationsPage.infoAria', { subject });

  /** What a chip is, what its state means, and whether conditions stand in front of it. */
  const chipTip = (
    chip: { readonly ruleName: string; readonly hintKey: string; readonly isEnabled: boolean },
    state: ChipState,
    hasConditions: boolean,
  ) => (
    <>
      <span className="block font-medium">
        {t('automationsPage.triggerMap.pathRule', { rule: chip.ruleName, key: chip.hintKey })}
      </span>
      <span className="block">{t(STATE_MEANING[state])}</span>
      {!chip.isEnabled && state !== 'paused' && (
        <span className="block">{t('automationsPage.triggerMap.ruleOffNote')}</span>
      )}
      {hasConditions && (
        <span className="block opacity-80">{t('automationsPage.triggerMap.conditional')}</span>
      )}
    </>
  );

  /** A chip's visible title and its accessible name. */
  const chipTitle = (chip: { readonly hintTitle: string | null; readonly hintKey: string }): string =>
    chip.hintTitle ?? t('automationsPage.triggerMap.noSuchHint', { key: chip.hintKey });
  const chipLabel = (chip: {
    readonly hintTitle: string | null;
    readonly hintKey: string;
    readonly ruleName: string;
    readonly isEnabled: boolean;
  }): string =>
    `${chipTitle(chip)} — ${t('automationsPage.triggerMap.pathRule', { rule: chip.ruleName, key: chip.hintKey })}${
      chip.isEnabled ? '' : ` — ${t('automationsPage.triggerMap.ruleOff')}`
    }`;

  /**
   * What pressing an offer does. Two branches of one button — the text is
   * created, or an existing text gets its stock words back — and a welcome is
   * applied for its own door only: the map adds no rule for the other one.
   */
  const offerTip = (template: HintTemplate, hintExists: boolean): string => {
    const press = hintExists
      ? t('automationsPage.triggerMap.offerHalfBuiltHint', { key: template.hintKey })
      : `${t(`automationsPage.hintTemplates.${template.id}.description`)}\n\n${t(
          'automationsPage.triggerMap.offerNew',
          { key: template.hintKey },
        )}`;
    if (!isArrivalTemplate(template)) return press;
    const otherId =
      template.id === ARRIVAL_TEMPLATE_IDS.telegram
        ? ARRIVAL_TEMPLATE_IDS.web
        : ARRIVAL_TEMPLATE_IDS.telegram;
    const other = templateById.get(otherId);
    const doorName = (spec: string): string => popupEventName(t, spec) ?? spec;
    return `${press}\n\n${t('automationsPage.triggerMap.offerOneDoor', {
      event: doorName(template.triggerSpec),
      other: doorName(other?.triggerSpec ?? ''),
    })}`;
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-1.5">
          <CardTitle className="text-sm">{t('automationsPage.triggerMap.title')}</CardTitle>
          <InfoTip label={infoAria(t('automationsPage.triggerMap.title'))}>
            {t('automationsPage.triggerMap.subtitle')}
          </InfoTip>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <Badge variant="outline" className={STATE_STYLE.live}>
            {t('automationsPage.triggerMap.counts.live', { count: map.counts.live })}
          </Badge>
          <Badge variant="outline" className={STATE_STYLE.paused}>
            {t('automationsPage.triggerMap.counts.paused', { count: map.counts.paused })}
          </Badge>
          {/* Only when there are any: a zero here would be a permanent warning
              colour on a page where nothing is wrong. */}
          {map.counts.broken > 0 && (
            <Badge variant="outline" className={STATE_STYLE['missing-hint']}>
              {t('automationsPage.triggerMap.counts.broken', { count: map.counts.broken })}
            </Badge>
          )}
          {/* Uncertain rules, counted apart from the certain failures and hidden
              at zero for the same reason. */}
          {map.counts.unverified > 0 && (
            <Badge variant="outline" className={STATE_STYLE.unverified}>
              {t('automationsPage.triggerMap.counts.unverified', { count: map.counts.unverified })}
            </Badge>
          )}
          <Badge variant="outline">
            {t('automationsPage.triggerMap.counts.unused', { count: map.counts.unused })}
          </Badge>
          <InfoTip label={infoAria(t('automationsPage.triggerMap.countsSubject'))}>
            {t('automationsPage.triggerMap.countsInfo')}
          </InfoTip>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {map.lanes.map((lane) => (
          <div key={lane.stage} className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t(`automationsPage.hintTemplates.stages.${lane.stage}`)}
            </p>
            <div className="space-y-1.5">
              {lane.triggers.map((node) => {
                // The operator's words for the event under its code. The code
                // stays first: it is what the rule editor takes.
                const eventName = popupEventName(t, node.type);
                return (
                  <div
                    key={node.type}
                    data-trigger={node.type}
                    className="flex flex-col gap-2 rounded-lg border p-2.5 sm:flex-row sm:items-start"
                  >
                    <div className="sm:w-64 sm:shrink-0">
                      <code className="text-[11px] break-all">{node.type}</code>
                      {eventName !== null && (
                        <p className="text-[11px] text-muted-foreground">{eventName}</p>
                      )}
                    </div>

                    <ArrowRight className="hidden h-3.5 w-3.5 shrink-0 translate-y-1 text-muted-foreground sm:block" />

                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                      {node.paths.map((path) => {
                        return (
                          <span
                            // A rule can carry both pop-up actions on one key.
                            key={`${path.ruleId}:${path.state === 'audience-on-event' ? 'audience' : 'hint'}:${path.hintKey}`}
                            className="inline-flex max-w-full items-center gap-1"
                          >
                            <PathChip
                              state={path.state}
                              title={chipTitle(path)}
                              label={chipLabel(path)}
                              hasConditions={path.hasConditions}
                              isEnabled={path.isEnabled}
                              offLabel={t('automationsPage.triggerMap.ruleOff')}
                            >
                              {chipTip(path, path.state, path.hasConditions)}
                            </PathChip>
                            {path.surfaceGap.length > 0 && (
                              // BESIDE the state, never instead of it: the path is
                              // built and switched on, and the people this event
                              // names open the cabinet where the hint may not be
                              // drawn. Green alone said "customers are seeing this"
                              // about the owner's welcome that reached nobody.
                              //
                              // An InfoTip and not a plain tooltip: this sentence is
                              // the only place on the map that says where those
                              // customers are, and a Radix tooltip never opens on a
                              // tap and closes on a click.
                              <InfoTip
                                label={t('automationsPage.triggerMap.gapMarker')}
                                icon={<MapPinOff className="h-3 w-3" aria-hidden />}
                                className="h-5 w-5 rounded-md border border-amber-500/50 bg-amber-500/15 text-amber-600 hover:text-amber-700 dark:text-amber-400"
                              >
                                {t('automationsPage.triggerMap.gap', {
                                  home: surfaceNames(t, path.surfaceGap),
                                })}
                              </InfoTip>
                            )}
                          </span>
                        );
                      })}

                      {node.offers.map((offer) => {
                        const template = templateById.get(offer.templateId);
                        if (template === undefined) return null;
                        // A TEMPLATE ALREADY APPLIED AND THEN ABANDONED looks
                        // exactly like one never touched — same dashed button —
                        // and it is not the same thing at all: the text row is
                        // written, sitting on the Hints tab firing for nobody,
                        // and only the rule is missing. `hintExists` has always
                        // been computed here and never shown, so the one place
                        // that could tell the operator said nothing. Applying it
                        // again is still the right move (it refreshes the words
                        // and re-opens the draft) — the button just has to admit
                        // what is already there.
                        const half = offer.hintExists;
                        return (
                          <ActionTip
                            key={offer.templateId}
                            tip={offerTip(template, half)}
                            disabled={templatePending}
                          >
                            <Button
                              size="sm"
                              variant="ghost"
                              className={
                                half
                                  ? 'h-6 border border-dashed border-amber-500/60 px-1.5 text-[11px] font-normal text-amber-600 dark:text-amber-400'
                                  : 'h-6 border border-dashed px-1.5 text-[11px] font-normal text-muted-foreground'
                              }
                              disabled={templatePending}
                              onClick={() => onUseTemplate(template)}
                            >
                              <Plus className="mr-1 h-3 w-3" />
                              {t(`automationsPage.hintTemplates.${template.id}.name`)}
                              {half && (
                                <span className="ml-1">
                                  · {t('automationsPage.triggerMap.offerHalfBuilt')}
                                </span>
                              )}
                            </Button>
                          </ActionTip>
                        );
                      })}

                      {node.wildcardRuleIds.length > 0 && (
                        // The reason a row that looks empty is not. One `*` rule
                        // covers everything, and an operator who adds a pop-up
                        // here without knowing that gets two. It sits with the
                        // row's content rather than under the event code, where
                        // it used to contradict «ничего не настроено» beside it.
                        <span className="text-[11px] text-muted-foreground">
                          {t('automationsPage.triggerMap.viaWildcard', {
                            count: node.wildcardRuleIds.length,
                          })}
                        </span>
                      )}

                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {map.eventlessFailures.length > 0 && (
          // These rules have no event row and fail on every automatic run. They
          // are counted under «Не сработает», so they are drawn here — a count
          // with nothing to press would be a promise the map breaks.
          <div className="space-y-1.5" data-section="eventless-failures">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('automationsPage.triggerMap.eventlessTitle')}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {map.eventlessFailures.map((failure) => (
                <PathChip
                  key={`${failure.ruleId}:${failure.reason}:${failure.hintKey}`}
                  state={failure.reason}
                  title={chipTitle(failure)}
                  label={chipLabel(failure)}
                  hasConditions={false}
                  isEnabled={failure.isEnabled}
                  offLabel={t('automationsPage.triggerMap.ruleOff')}
                >
                  {chipTip(failure, failure.reason, false)}
                </PathChip>
              ))}
            </div>
          </div>
        )}

        {map.orphanHints.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('automationsPage.triggerMap.orphans')}
              </p>
              <InfoTip label={infoAria(t('automationsPage.triggerMap.orphans'))}>
                {t('automationsPage.triggerMap.orphansHint')}
              </InfoTip>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {map.orphanHints.map((orphan) => (
                <Badge key={orphan.key} variant="outline" className="font-normal">
                  {orphan.title}
                  {!orphan.isActive && (
                    <span className="ml-1 text-muted-foreground">
                      {t('automationsPage.triggerMap.off')}
                    </span>
                  )}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
