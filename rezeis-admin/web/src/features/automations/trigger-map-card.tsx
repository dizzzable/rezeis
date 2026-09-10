import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowRight, Check, Filter, Pause, Plus } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { listUserHints } from '@/features/user-hints/user-hints-api';

import { listRules } from './automations-api';
import { HINT_TEMPLATES, type HintTemplate } from './hint-templates';
import { buildTriggerMap, type TriggerPathState } from './trigger-map';

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
 */

const STATE_STYLE: Record<TriggerPathState, string> = {
  live: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  paused: 'border-muted-foreground/30 bg-muted text-muted-foreground',
  'missing-hint': 'border-destructive/50 bg-destructive/10 text-destructive',
  'hint-inactive': 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
};

const STATE_ICON: Record<TriggerPathState, typeof Check> = {
  live: Check,
  paused: Pause,
  'missing-hint': AlertTriangle,
  'hint-inactive': AlertTriangle,
};

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

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{t('automationsPage.triggerMap.title')}</CardTitle>
        <p className="text-xs text-muted-foreground">
          {t('automationsPage.triggerMap.subtitle')}
        </p>
        <div className="flex flex-wrap gap-1.5 pt-1">
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
          <Badge variant="outline">
            {t('automationsPage.triggerMap.counts.unused', { count: map.counts.unused })}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {map.lanes.map((lane) => (
          <div key={lane.stage} className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t(`automationsPage.hintTemplates.stages.${lane.stage}`)}
            </p>
            <div className="space-y-1.5">
              {lane.triggers.map((node) => (
                <div
                  key={node.type}
                  className="flex flex-col gap-2 rounded-lg border p-2.5 sm:flex-row sm:items-start"
                >
                  <div className="sm:w-64 sm:shrink-0">
                    <code className="text-[11px] break-all">{node.type}</code>
                    {node.wildcardRuleIds.length > 0 && (
                      // The reason a row that looks empty is not. One `*` rule
                      // covers everything, and an operator who adds a pop-up
                      // here without knowing that gets two.
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {t('automationsPage.triggerMap.viaWildcard', {
                          count: node.wildcardRuleIds.length,
                        })}
                      </p>
                    )}
                  </div>

                  <ArrowRight className="hidden h-3.5 w-3.5 shrink-0 translate-y-1 text-muted-foreground sm:block" />

                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                    {node.paths.map((path) => {
                      const Icon = STATE_ICON[path.state];
                      return (
                        <span
                          key={`${path.ruleId}:${path.hintKey}`}
                          className={`inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${STATE_STYLE[path.state]}`}
                          title={`${path.ruleName} → ${path.hintKey}`}
                        >
                          <Icon className="h-3 w-3 shrink-0" />
                          <span className="truncate">
                            {path.hintTitle ??
                              t('automationsPage.triggerMap.noSuchHint', { key: path.hintKey })}
                          </span>
                          {path.hasConditions && (
                            // Green means "customers are seeing this", and a
                            // rule with conditions may be reaching four people
                            // or none — the map cannot tell, and neither could
                            // the operator reading it.
                            <Filter
                              className="h-3 w-3 shrink-0 opacity-70"
                              aria-label={t('automationsPage.triggerMap.conditional')}
                            />
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
                        <Button
                          key={offer.templateId}
                          size="sm"
                          variant="ghost"
                          className={
                            half
                              ? 'h-6 border border-dashed border-amber-500/60 px-1.5 text-[11px] font-normal text-amber-600 dark:text-amber-400'
                              : 'h-6 border border-dashed px-1.5 text-[11px] font-normal text-muted-foreground'
                          }
                          disabled={templatePending}
                          onClick={() => onUseTemplate(template)}
                          title={
                            half
                              ? t('automationsPage.triggerMap.offerHalfBuiltHint', {
                                  key: offer.hintKey,
                                })
                              : t(`automationsPage.hintTemplates.${template.id}.description`)
                          }
                        >
                          <Plus className="mr-1 h-3 w-3" />
                          {t(`automationsPage.hintTemplates.${template.id}.name`)}
                          {half && (
                            <span className="ml-1">
                              · {t('automationsPage.triggerMap.offerHalfBuilt')}
                            </span>
                          )}
                        </Button>
                      );
                    })}

                    {node.paths.length === 0 && node.offers.length === 0 && (
                      <span className="text-[11px] text-muted-foreground">
                        {t('automationsPage.triggerMap.nothingHere')}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {map.orphanHints.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('automationsPage.triggerMap.orphans')}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {t('automationsPage.triggerMap.orphansHint')}
            </p>
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
