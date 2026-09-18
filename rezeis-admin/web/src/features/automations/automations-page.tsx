/**
 * Automations page.
 *
 * Two-pane layout: rule list on the left, rule editor on the right.
 * Selecting a rule loads its full configuration; the editor renders a
 * compact form for trigger + conditions + actions, and a tab below for
 * the per-rule execution log.
 *
 * Realtime: every automation execution emits a SystemEvent which our
 * realtime hook turns into an `['admin', 'automations']` invalidation
 * (we add the key here so the list refreshes when something fires).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as SelectPrimitive from '@radix-ui/react-select';
import {
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Lightbulb,
  Loader2,
  MessageSquare,
  PlayCircle,
  Plus,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';

import { InfoTip, LabelWithInfo } from '@/components/ui/info-tip';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { listUserHints } from '@/features/user-hints/user-hints-api';
import {
  actionsNeedingPermission,
  permissionList,
  useMissingActionPermissions,
  type ActionPermissionMap,
  type PermissionRef,
} from './action-permissions';
import { ArrivalTemplateCard } from './arrival-template-card';
import { translateAutomationError } from './automation-errors';
import { findHintCollisionsWithCompanions } from './hint-collision';
import { getEventCatalog } from './event-catalog-api';
import { ACTION_LABEL_KEYS, actionLabel } from './rule-action-labels';
import { ButtonTip } from './rule-button-tip';
import {
  companionPayload,
  companionsInForce,
  type DraftCompanion,
  type DraftSeed,
} from './rule-companions';
import { RuleCompanionsNotice } from './rule-companions-notice';
import { RuleHintWarnings } from './rule-hint-warnings';
import { RuleRunDialog } from './rule-run-dialog';
import { isUrlHidden, paramsWithHeaderKept, paramsWithoutHeader, savedUrlFor } from './saved-header';
import { actionResultText, executionLogNote, runHadNoAnswer, runToastText } from './run-result-copy';
import { ExecutionStatusBadge } from './run-status-badge';
import { TriggerCatalogHint } from './trigger-catalog-hint';
import { TriggerMapCard } from './trigger-map-card';
import { useRuleDraft } from './use-rule-draft';
import { WebhookHeaderField } from './webhook-header-field';
import { useTabSync } from '@/lib/use-tab-sync';
import { UserHintsTab } from '@/features/user-hints/user-hints-tab';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/utils';
import { translateApiError } from '@/lib/translate-error';
import {
  type AutomationActionDef,
  type AutomationActionType,
  type AutomationRule,
  type AutomationTriggerKind,
  type UpsertRulePayload,
  createRule as apiCreateRule,
  deleteRule as apiDeleteRule,
  getCatalog,
  getRule,
  listExecutions,
  listRules,
  runRuleManually,
  toggleRule,
  updateRule as apiUpdateRule,
} from './automations-api';

const RULES_KEY = ['admin', 'automations', 'rules'] as const;

/** The id the editor opens an unsaved draft under. No rule and no query carries it. */
const NEW_RULE_ID = '__new__';

/**
 * What the editor is on: the rule chosen in the list, and the unsaved draft
 * behind `NEW_RULE_ID` when that is the choice. One value, because a late
 * answer has to weigh both halves at once — see where it is held.
 */
type EditorTarget = {
  readonly selectedId: string | null;
  readonly draftSeed: DraftSeed | null;
  /**
   * WHICH draft, behind the one id they all share. Every draft opens under
   * `NEW_RULE_ID`, so a second one opened while the first was being created
   * reached the same editor instance — and inherited its state: every field
   * disabled and «Создать» spinning, on a draft nothing was being created for.
   * Counted per draft, it goes into the editor's key, and each gets its own.
   */
  readonly draftNo: number;
};

/**
 * Ready-to-use rule templates. Clicking "use" opens the editor pre-filled with
 * a draft (not saved until the operator reviews + presses Create). `textKey`
 * lets the seed Telegram message be localized at apply time.
 */
import {
  HINT_TEMPLATES,
  HINT_TEMPLATE_STAGES,
  buildHint,
  buildHintAction,
  isArrivalTemplate,
  type HintTemplatePlan,
} from './hint-templates';
import { createUserHint, updateUserHint } from '@/features/user-hints/user-hints-api';
import { useHasPermission } from '@/features/rbac/permission-gate';

interface RuleTemplate {
  readonly id: string;
  readonly triggerKind: AutomationTriggerKind;
  readonly triggerSpec: string;
  readonly conditions?: unknown;
  readonly buildActions: (text: (key: string) => string) => AutomationActionDef[];
}

const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    id: 'payment_failed_notify',
    triggerKind: 'REALTIME',
    triggerSpec: 'payment.failed',
    buildActions: (text) => [{ type: 'notify_telegram', params: { text: text('automationsPage.templates.payment_failed_notify.message') } }],
  },
  // «Антифрод → блок IP + Telegram» was here, and it could never work: it
  // blocked «the address the event carries», and `fraud.signal_opened` carries
  // none — no event does (see `assertBlockAddressAvailable` on the panel). Every
  // rule made from it failed «no address» on every signal, so it is retired
  // rather than offered.
  {
    id: 'node_down_notify',
    triggerKind: 'REALTIME',
    triggerSpec: 'node.connection_lost',
    buildActions: (text) => [{ type: 'notify_telegram', params: { text: text('automationsPage.templates.node_down_notify.message') } }],
  },
  {
    id: 'payment_completed_webhook',
    triggerKind: 'REALTIME',
    triggerSpec: 'payment.completed',
    buildActions: () => [{ type: 'webhook_post', params: { url: 'https://example.com/hooks/payment', authorizationHeader: 'Bearer <token>' } }],
  },
  {
    id: 'daily_healthcheck_cron',
    triggerKind: 'CRON',
    triggerSpec: '0 9 * * *',
    buildActions: () => [{ type: 'webhook_post', params: { url: 'https://example.com/healthcheck' } }],
  },
];

export default function AutomationsPage() {
  const { t } = useTranslation();
  // A POP-UP NEEDS TWO GRANTS AND THE PANEL HANDS THEM OUT SEPARATELY.
  //
  // `user_hints:create` writes the text; `automations:create` writes the rule
  // that shows it. A role with the first and not the second could press "use
  // template", watch the text row be written, watch the draft rule open — and
  // then get a 403 from Create, leaving a hint on the Hints tab that nothing
  // fires and that they cannot finish. The order made it worse: the half that
  // succeeds runs first, so the failure always arrives after the damage.
  const mayWriteHint = useHasPermission('user_hints', 'create');
  const mayWriteRule = useHasPermission('automations', 'create');
  const mayEditHint = useHasPermission('user_hints', 'edit');
  // Two page-level tabs, synced to the hash so a shared link lands where it was
  // sent. Hints live here rather than on a page of their own because an
  // operator reaches for them while thinking about triggers — but their editor
  // is a separate file, since this one is already long enough.
  // Three tabs, and the map is a peer of the other two rather than a panel
  // inside them: an operator opens it with a MOMENT in mind — "somebody is
  // about to run out and I want to say something" — not with a rule or a
  // hint in mind, which is exactly why neither of the other two could show it.
  const { activeTab, setTab } = useTabSync(['rules', 'hints', 'map'] as const, 'rules');
  const queryClient = useQueryClient();
  const rulesQuery = useQuery({
    queryKey: RULES_KEY,
    queryFn: listRules,
  });
  const catalogQuery = useQuery({
    queryKey: ['admin', 'automations', 'catalog'],
    queryFn: getCatalog,
    staleTime: 5 * 60 * 1000,
  });
  // What each action needs beyond the automations permissions — the server's
  // own map, so the page greys out exactly what a save, the switch and a run
  // would be refused for (`action-permissions.ts`).
  const actionPermissions = catalogQuery.data?.actionPermissions;

  // (see `editorTarget` below — the selection and the open draft are one state)
  // THE UNSAVED DRAFT LIVES HERE, not in the query cache.
  //
  // It used to be written into the cache under `__new__` and read back by a
  // query function that returned whatever the cache held. The editor exists
  // only on «Правила», so on any other tab nothing observed that entry; once
  // its `gcTime` had passed the cache collected it, and back on the tab the
  // query handed TanStack `undefined` — "data is undefined", with «Повторить»
  // asking the same empty cache again for ever. Page state outlives a tab.
  //
  // WHICH RULE AND WHICH DRAFT ARE ONE PIECE OF STATE. A save answers later than
  // the press, and both halves decide whether its answer still concerns the
  // operator: a created rule opens only while the selection is still the very
  // draft it came from. Two separate states cannot be asked that question
  // together — each updater sees only its own half — so they are one here, and
  // every late answer decides INSIDE the updater, on the state React is about
  // to write, not on a copy a render or an effect behind.
  const [editorTarget, setEditorTarget] = useState<EditorTarget>({
    selectedId: null,
    draftSeed: null,
    draftNo: 0,
  });
  const { selectedId, draftSeed } = editorTarget;

  // WHETHER THE PAGE IS STILL HERE, for answers that arrive later than the
  // press. A mutation's own callbacks outlive the page, and a hint template's
  // switches tabs — a navigation to this page's address, from a page that is
  // gone. Where the operator stands WITHIN the page is `editorTarget`, read
  // inside the updater rather than from a ref.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Opens the editor with an unsaved draft under the synthetic `__new__` id
  // (shared by the blank "New rule" button and the templates).
  function openDraft(
    seed: Partial<AutomationRule> & { name: string; actions: AutomationActionDef[] },
    companions: readonly DraftCompanion[] = [],
  ) {
    const blank: AutomationRule = {
      id: '',
      name: seed.name,
      description: seed.description ?? null,
      isEnabled: false,
      triggerKind: seed.triggerKind ?? 'REALTIME',
      triggerSpec: seed.triggerSpec ?? 'payment.failed',
      conditions: seed.conditions ?? null,
      actions: seed.actions,
      createdById: null,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunMessage: null,
      runCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setEditorTarget((current) => ({
      selectedId: NEW_RULE_ID,
      draftSeed: { rule: blank, companions },
      draftNo: current.draftNo + 1,
    }));
  }

  /**
   * A pop-up template creates BOTH halves, because neither half works alone.
   *
   * The hint is written immediately (it is inert until something fires it), and
   * the rule opens as a draft the operator still has to press Create on — so
   * nothing reaches a customer without a review, and the operator never meets
   * the failure where a rule fires a hint key that does not exist.
   *
   * An existing hint with the same key is UPDATED rather than duplicated: keys
   * are what a rule points at, so a second one would be unreachable, and the
   * operator applying a template twice means "give me the stock text back".
   */
  const applyHintTemplate = useMutation({
    // A PLAN, not a bare template: the hint and draft of `template`, and the
    // companion rules «Создать» adds (only «Первое появление» for everyone has
    // any). Every branch below is about the hint alone, so it reads `template`.
    mutationFn: async ({ template }: HintTemplatePlan) => {
      // Checked before the first write, not after it. The server still refuses
      // on its own — this is the difference between being told now and being
      // told once there is a stray row to clean up.
      if (!mayWriteRule) {
        throw new Error(
          t('automationsPage.hintTemplates.needsBoth', { missing: 'automations:create' }),
        );
      }

      const payload = buildHint(template, (key) => String(t(key)));
      const existing = (await listUserHints()).find((hint) => hint.key === template.hintKey);

      // WHICH GRANT DEPENDS ON WHICH BRANCH, and the first version of this
      // check only knew about one of them. Writing a new hint is
      // `user_hints:create`; refreshing one that already exists is
      // `user_hints:edit`, because it goes out as a PUT.
      //
      // The button that exists ONLY for the second branch is the amber
      // "text ready, no rule" one on the map — so a role holding every grant
      // the old check asked for pressed the one button meant for it, got a
      // bare server refusal, and could never finish. The branch is known by
      // now, so the check belongs here rather than up front.
      const needed = existing === undefined ? 'user_hints:create' : 'user_hints:edit';
      if (!(existing === undefined ? mayWriteHint : mayEditHint)) {
        throw new Error(t('automationsPage.hintTemplates.needsBoth', { missing: needed }));
      }
      // WHICH BRANCH RAN IS CARRIED OUT, not re-derived in `onSuccess`.
      //
      // The two branches leave the operator in genuinely different places and
      // the toast is the only thing that says which — see the comment on the
      // `existed` flag where it is read. Re-checking `listUserHints()` from
      // `onSuccess` would ask the question a second time, after the write that
      // changes the answer.
      if (existing === undefined) return { hint: await createUserHint(payload), existed: false };
      // Refresh the WORDS, keep the operator's aiming.
      //
      // This branch was unreachable until the keys were fixed, and the first
      // time it ran it would have undone real work: a template ships no
      // audience at all, so a hint narrowed to Telegram on mobile went back to
      // everyone everywhere, its `groupKey` — the thing that stops two windows
      // stacking — was cleared, and a hint the operator had switched OFF was
      // switched back on for customers. Applying a template twice means "give
      // me the stock text back", not "forget who I aimed it at".
      // "REFRESH THE WORDS" MEANS THE WORDS. The spread kept the audience and
      // the on/off switch and then quietly reset everything else the operator
      // had touched: where the button points, how long the pop-up stays
      // showable, whether it may arrive more than once, and whether it is a
      // modal or a toast. `ctaTarget` is aiming as surely as `surfaces` is —
      // an operator who repointed the expiry pop-up at /plans and raised its
      // window to 72 hours lost both by pressing the one button the map offers
      // them for resuming a half-built pop-up.
      //
      // AND A SETTING THE OPERATOR REMOVED IS KEPT REMOVED. The group and the
      // button were kept only when the hint HAD one, so a group the operator
      // had cleared or a button they had taken off came back from the template
      // — under a toast saying the other settings were kept. The PUT replaces
      // the whole row (`user-hint.service.ts`, `buildWriteData`): an empty
      // `groupKey` is written as no group, and a button of kind NONE loses its
      // words and destination. A kept button travels WITH its words, which
      // belong to the destination the operator chose — and without which the
      // server refuses a button outright, as it did whenever the template had
      // no button of its own.
      const {
        ctaLabelRu: _templateLabelRu,
        ctaLabelEn: _templateLabelEn,
        ctaTarget: _templateTarget,
        ...words
      } = payload;
      const hint = await updateUserHint(existing.id, {
        ...words,
        surfaces: existing.surfaces,
        formFactors: existing.formFactors,
        groupKey: existing.groupKey ?? '',
        isActive: existing.isActive,
        mode: existing.mode,
        tone: existing.tone,
        ttlHours: existing.ttlHours,
        isRepeatable: existing.isRepeatable,
        ctaKind: existing.ctaKind,
        ...(existing.ctaKind === 'NONE'
          ? {}
          : {
              ctaTarget: existing.ctaTarget ?? undefined,
              ctaLabelRu: existing.ctaLabelRu ?? undefined,
              ctaLabelEn: existing.ctaLabelEn ?? '',
            }),
      });
      return { hint, existed: true };
    },
    onSuccess: ({ hint, existed }, plan) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'user-hints'] });
      // NOT AFTER THE OPERATOR HAS LEFT. The tab switch below is a navigation
      // to this page's own address, so an answer landing once they had gone
      // elsewhere dragged them back — to a draft the unmounted page no longer
      // holds. The text is written either way; the map offers the rest.
      if (!mounted.current) return;
      // THE DRAFT OPENS ON THE RULES TAB, because that is the only tab that
      // renders the rule editor.
      //
      // The template buttons exist on two tabs. Pressed from the MAP — the tab
      // built for exactly this — the hint was written, the toast said "review
      // the rule and press Create", and there was no rule anywhere on screen to
      // review: the editor lives inside `activeTab === 'rules'`. The map then
      // redrew the same button, now amber, and pressing it again repeated the
      // whole loop for ever.
      setTab('rules');
      const { template, companions } = plan;
      openDraft(
        {
          name: t(`automationsPage.hintTemplates.${template.id}.name`),
          // A companion copies the draft's description along with the rest of
          // its payload, so a draft that brings one opens with a description
          // true of every rule it creates — not the Telegram welcome's, which
          // would be false on the rule for the site.
          description:
            companions.length > 0 && isArrivalTemplate(template)
              ? t('automationsPage.hintTemplates.arrival.ruleDescription')
              : t(`automationsPage.hintTemplates.${template.id}.description`),
          triggerKind: 'REALTIME',
          triggerSpec: template.triggerSpec,
          actions: buildHintAction(template),
        },
        companions.map((companion) => ({
          triggerSpec: companion.triggerSpec,
          name: t(`automationsPage.hintTemplates.${companion.nameTemplateId}.name`),
        })),
      );
      // ONE BUTTON, TWO OUTCOMES, AND ONLY ONE OF THEM WAITS FOR ANYTHING.
      //
      // Both branches used to end on `created`, which says the text was created
      // and asks the operator to review the rule and press Create. On the update
      // branch every clause of that is false: nothing was created, the PUT above
      // has already landed, and if an enabled rule is showing the hint the new
      // words are in front of customers before the toast finishes fading. The
      // draft that opens under it would add a SECOND rule for a key that already
      // has one — so an operator following the sentence does the one thing the
      // situation does not want.
      //
      // `updated` says that instead. It is a different sentence in both
      // dictionaries, not a rename of the same one.
      //
      // A draft with companions gets the sibling of each, because «Создать»
      // then saves more than one rule and the sentence has to say how many.
      if (companions.length === 0) {
        toast.success(
          t(
            existed
              ? 'automationsPage.hintTemplates.updated'
              : 'automationsPage.hintTemplates.created',
            { title: hint.titleRu },
          ),
        );
      } else {
        toast.success(
          t(
            existed
              ? 'automationsPage.hintTemplates.updatedWithCompanions'
              : 'automationsPage.hintTemplates.createdWithCompanions',
            { title: hint.titleRu, count: 1 + companions.length },
          ),
        );
      }
    },
    // The server's own sentence, IN THE OPERATOR'S LANGUAGE. A rejected payload
    // comes back from `ValidationPipe` as one line per field and those lines are
    // the whole diagnosis: every template once shipped with a key the server
    // refuses, and a toast that said only "something went wrong" made the
    // feature look broken rather than wrong in a specific, fixable way.
    //
    // `getErrorMessage` got the sentence onto the screen and left it in English:
    // it is a pure extractor and does no dictionary lookup at all, so a Russian
    // operator read the server's raw wire copy. `translateApiError` runs the
    // same extraction through `errors.<sentence>` and, for a request that never
    // reached the server, says so rather than reporting a dead host as a
    // refusal. Its own generic replaces the fallback that used to be passed in.
    onError: (error) => toast.error(translateApiError(t, error)),
  });

  function useTemplate(template: RuleTemplate) {
    openDraft({
      name: t(`automationsPage.templates.${template.id}.name`),
      description: t(`automationsPage.templates.${template.id}.description`),
      triggerKind: template.triggerKind,
      triggerSpec: template.triggerSpec,
      conditions: template.conditions ?? null,
      actions: template.buildActions((key) => String(t(key))),
    });
  }

  // Auto-select the first rule once data is loaded. Uses the
  // "store-prev-prop in render" pattern to avoid an effect.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [selectInitialized, setSelectInitialized] = useState(false);
  if (!selectInitialized && rulesQuery.data && rulesQuery.data.length > 0) {
    setSelectInitialized(true);
    if (selectedId === null) {
      const first = rulesQuery.data[0]?.id ?? null;
      setEditorTarget((current) => (current.selectedId === null ? { ...current, selectedId: first } : current));
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          {/* The (i) sits BESIDE the heading, not in it: inside, its name would
              become part of the heading's own. */}
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Zap className="h-6 w-6" />
              {t('automationsPage.title')}
            </h1>
            <InfoTip
              label={t('automationsPage.infoAria', { subject: t('automationsPage.title') })}
              side="bottom"
              align="start"
            >
              {t('automationsPage.pageInfo')}
            </InfoTip>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {t('automationsPage.subtitle')}
          </p>
        </div>
        {activeTab === 'rules' && (
          <ButtonTip tip={t('automationsPage.tips.newRule')}>
            <Button
              onClick={() => {
                openDraft({
                  name: t('automationsPage.untitledRule'),
                  actions: [{ type: 'notify_telegram', params: { text: 'Triggered' } }],
                });
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              {t('automationsPage.newRule')}
            </Button>
          </ButtonTip>
        )}
      </header>

      <Tabs value={activeTab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="rules">{t('automationsPage.tabs.rules')}</TabsTrigger>
          <TabsTrigger value="hints">{t('automationsPage.tabs.hints')}</TabsTrigger>
          <TabsTrigger value="map">{t('automationsPage.tabs.map')}</TabsTrigger>
        </TabsList>
      </Tabs>

      {activeTab === 'hints' && <UserHintsTab />}

      {activeTab === 'map' && (
        <TriggerMapCard
          // The map applies one template for its own event: no companions.
          onUseTemplate={(template) => applyHintTemplate.mutate({ template, companions: [] })}
          templatePending={applyHintTemplate.isPending}
        />
      )}

      {activeTab === 'rules' && (
        <HelpAndTemplates
          onUseTemplate={useTemplate}
          onUseHintTemplate={(plan) => applyHintTemplate.mutate(plan)}
          hintTemplatePending={applyHintTemplate.isPending}
          actionPermissions={actionPermissions}
        />
      )}

      {activeTab === 'rules' && rulesQuery.error && (
        <Alert variant="destructive">
          <AlertTitle>{t('automationsPage.errors.title')}</AlertTitle>
          {/* The reason as well as the fact: a 403 and a dead backend are
              different things to go and fix. */}
          <AlertDescription>
            {t('automationsPage.errors.loadRules')} {translateAutomationError(t, rulesQuery.error)}
          </AlertDescription>
        </Alert>
      )}

      {activeTab === 'rules' && (
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <RuleList
          rules={rulesQuery.data ?? []}
          loading={rulesQuery.isLoading}
          actionPermissions={actionPermissions}
          selectedId={selectedId}
          onSelect={(id) => setEditorTarget((current) => ({ ...current, selectedId: id }))}
          onToggle={(id, enabled) => {
            void toggleRule(id, enabled)
              .then((toggled) => {
                // THE ANSWER IS THE RULE AS IT NOW STANDS, so it becomes that
                // rule's copy — not only the list's. The editor open on it kept
                // the old «Включено», and «Сохранить» wrote the old switch back;
                // a rule opened later was served the old copy while it counted
                // as fresh. The open draft takes the new switch and keeps the
                // rest of what was typed (`useRuleDraft`).
                if (toggled && toggled.id === id) {
                  const ruleKey = ['admin', 'automations', 'rule', id];
                  void queryClient.cancelQueries({ queryKey: ruleKey, exact: true });
                  queryClient.setQueryData(ruleKey, toggled);
                }
                queryClient.invalidateQueries({ queryKey: RULES_KEY });
              })
              .catch((err) => {
                // Same lookup as every other refusal on this page. The switch is
                // the one control an operator reaches for while something is
                // already going wrong, and `getErrorMessage` handed them the
                // server's English — 'Rule not found', 'Forbidden resource' —
                // under a Russian interface. Switching ON is checked like a
                // save now, so its refusals name a permission, a condition or
                // an address; `translateAutomationError` says which.
                // Named: the list holds many switches, and the toast outlives
                // the moment the operator knew which one they pressed.
                const name = rulesQuery.data?.find((rule) => rule.id === id)?.name ?? id;
                toast.error(
                  t('automationsPage.toast.toggleFailed', { name, message: translateAutomationError(t, err) }),
                );
                // Refetch to revert any optimistic Switch UI back to source of truth.
                queryClient.invalidateQueries({ queryKey: RULES_KEY });
                // 409: the rule changed between the check and the switch. The
                // editor open on it reloads it too, so what the operator decides
                // on next is what the rule now holds.
                if ((err as { response?: { status?: number } } | null)?.response?.status === 409) {
                  void queryClient.invalidateQueries({ queryKey: ['admin', 'automations', 'rule', id], exact: true });
                }
              });
          }}
        />
        {selectedId === null || (selectedId === NEW_RULE_ID && draftSeed === null) ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              {t('automationsPage.selectPrompt')}
            </CardContent>
          </Card>
        ) : (
          // ONE EDITOR PER RULE. Shared by every rule, it carried its own state
          // onto the next one: «Выполнения» stayed selected — on a new draft,
          // which has no such tab, the card had no body — and a save still
          // running on one rule kept «Сохранить» spinning and disabled on the
          // next.
          <RuleEditor
            key={selectedId === NEW_RULE_ID ? `${NEW_RULE_ID}:${editorTarget.draftNo}` : selectedId}
            ruleId={selectedId}
            draftSeed={selectedId === NEW_RULE_ID ? draftSeed : null}
            actionCatalog={catalogQuery.data?.actionTypes ?? []}
            actionPermissions={actionPermissions}
            onSaved={(rule, { created, fromId, fromSeed }) => {
              // THE ANSWER TO A SAVE IS THE RULE AS SAVED, so it becomes this
              // rule's copy. Refreshing only the list left the copy read BEFORE
              // the save in the cache, fresh for another half-minute: back on
              // the rule, the editor was seeded from it — the old name, the old
              // switch — and a second «Сохранить» wrote the old rule back over
              // the new one. A rule just created opens from it at once, too.
              //
              // A read of this rule still out (after «Запустить», say) carries
              // the rule as it stood before the save and would land on top of
              // this answer, so it is called off first.
              const ruleKey = ['admin', 'automations', 'rule', rule.id];
              void queryClient.cancelQueries({ queryKey: ruleKey, exact: true });
              queryClient.setQueryData(ruleKey, rule);
              queryClient.invalidateQueries({ queryKey: RULES_KEY });
              // ONLY IF THE OPERATOR IS STILL ON WHAT WAS SAVED. An answer that
              // lands after they opened another rule used to pull them back to
              // this one; a create that lands after they opened another draft
              // closed that draft. A created rule is opened only while the
              // selection is still the very draft it was created from.
              //
              // Asked INSIDE the updater, on the state React is about to write.
              // A copy kept in a ref is written by an effect, which React runs
              // after the commit — an answer landing in between read the place
              // the operator had already left.
              setEditorTarget((current) => {
                const stillHere = created
                  ? current.selectedId === NEW_RULE_ID && current.draftSeed?.rule === fromSeed
                  : current.selectedId === fromId;
                if (!stillHere) return current;
                // The draft is a rule now; nothing will open it again.
                return { ...current, selectedId: rule.id, draftSeed: created ? null : current.draftSeed };
              });
            }}
            onDeleted={() => {
              setEditorTarget((current) => ({ ...current, selectedId: null }));
              queryClient.invalidateQueries({ queryKey: RULES_KEY });
            }}
            // «Не создавать эти правила». The rule object is kept as it is,
            // so the draft taken from it — and whatever was typed into it —
            // does not start over (`useRuleDraft` keys on its content).
            onDropCompanions={() => {
              setEditorTarget((current) =>
                current.draftSeed === null
                  ? current
                  : { ...current, draftSeed: { ...current.draftSeed, companions: [] } },
              );
            }}
          />
        )}
      </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

/**
 * Collapsible onboarding panel: explains how automations work, lists trigger
 * and action types, shows example use-cases, and offers one-click templates
 * that open the editor pre-filled (unsaved until reviewed).
 */
function HelpAndTemplates({
  onUseTemplate,
  onUseHintTemplate,
  hintTemplatePending,
  actionPermissions,
}: {
  onUseTemplate: (template: RuleTemplate) => void;
  onUseHintTemplate: (plan: HintTemplatePlan) => void;
  hintTemplatePending: boolean;
  actionPermissions: ActionPermissionMap | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // A template whose actions this role could never save opens nothing: the
  // draft it would open cannot be created, and the operator would find out
  // only on «Создать».
  const missingFor = useMissingActionPermissions(actionPermissions);

  const steps = ['trigger', 'condition', 'action'] as const;
  const triggerKinds = ['realtime', 'cron', 'manual'] as const;
  const actionTypes: AutomationActionType[] = ['notify_telegram', 'webhook_post', 'block_ip', 'block_user', 'show_hint', 'show_hint_to_audience', 'system_event'];
  const useCases = ['fraud', 'nodeDown', 'payment', 'daily'] as const;

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 px-6 py-4 text-left"
            aria-expanded={open}
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <BookOpen className="h-4 w-4 text-primary" />
              {t('automationsPage.help.title')}
            </span>
            <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-5 pt-0">
            <p className="text-sm text-muted-foreground">{t('automationsPage.help.intro')}</p>

            {/* How it works — trigger → condition → action */}
            <div className="grid gap-3 sm:grid-cols-3">
              {steps.map((step) => (
                <div key={step} className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-xs font-semibold">{t(`automationsPage.help.steps.${step}.title`)}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{t(`automationsPage.help.steps.${step}.body`)}</p>
                </div>
              ))}
            </div>

            {/* Trigger kinds + action types */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <p className="text-xs font-semibold">{t('automationsPage.help.triggersTitle')}</p>
                <ul className="space-y-1 text-[11px] text-muted-foreground">
                  {triggerKinds.map((k) => (
                    <li key={k}>
                      <span className="font-medium text-foreground">{t(`automationsPage.triggers.${k}`)}</span>
                      {' — '}
                      {t(`automationsPage.help.triggerKinds.${k}`)}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-semibold">{t('automationsPage.help.actionsTitle')}</p>
                <ul className="space-y-1 text-[11px] text-muted-foreground">
                  {actionTypes.map((a) => (
                    <li key={a}>
                      <span className="font-medium text-foreground">{t(ACTION_LABEL_KEYS[a])}</span>
                      {' — '}
                      {t(`automationsPage.help.actionDescriptions.${a}`)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Example use-cases */}
            <div className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-xs font-semibold">
                <Lightbulb className="h-3.5 w-3.5 text-amber-500" />
                {t('automationsPage.help.useCasesTitle')}
              </p>
              <ul className="ml-4 list-disc space-y-1 text-[11px] text-muted-foreground">
                {useCases.map((u) => (
                  <li key={u}>{t(`automationsPage.help.useCases.${u}`)}</li>
                ))}
              </ul>
            </div>

            {/* Conditions hint */}
            <div className="rounded-md bg-muted/50 px-3 py-2">
              <p className="text-[11px] text-muted-foreground">{t('automationsPage.help.conditionsHint')}</p>
            </div>

            <Separator />

            {/* One-click templates */}
            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-xs font-semibold">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                {t('automationsPage.help.templatesTitle')}
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {RULE_TEMPLATES.map((tpl) => {
                  // Only the TYPES matter here, so the texts are left as keys.
                  const templateActions = tpl.buildActions((key) => key);
                  const missing = missingFor(templateActions);
                  const blocked = missing.length > 0;
                  return (
                    <div key={tpl.id} className="flex flex-col rounded-lg border p-3">
                      <p className="text-xs font-medium">{t(`automationsPage.templates.${tpl.id}.name`)}</p>
                      <p className="mt-0.5 mb-2 flex-1 text-[11px] text-muted-foreground">
                        {t(`automationsPage.templates.${tpl.id}.description`)}
                      </p>
                      <code className="mb-2 truncate text-[10px] text-muted-foreground">{tpl.triggerSpec}</code>
                      <ButtonTip
                        tip={
                          blocked
                            ? t('automationsPage.tips.templateNeedsPermission', {
                                actions: actionsNeedingPermission(t, templateActions, missingFor),
                                permissions: permissionList(t, missing),
                              })
                            : t('automationsPage.tips.useRuleTemplate')
                        }
                        disabled={blocked}
                        className="flex [&>*]:flex-1"
                      >
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={blocked}
                          onClick={() => onUseTemplate(tpl)}
                        >
                          <Plus className="mr-1.5 h-3.5 w-3.5" />
                          {t('automationsPage.help.useTemplate')}
                        </Button>
                      </ButtonTip>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Pop-ups, separate from the rule templates above because they
                create two things rather than one, and because an operator
                looking for "show the customer something" is not looking for
                "notify me in Telegram". */}
            <div className="space-y-2">
              {/* The explanation is behind the (i); the heading stays the
                  section's first child, which the template tests look up. */}
              <p className="flex items-center gap-1.5 text-xs font-semibold">
                <MessageSquare className="h-3.5 w-3.5 text-primary" />
                {t('automationsPage.hintTemplates.title')}
                <InfoTip
                  label={t('automationsPage.infoAria', {
                    subject: t('automationsPage.hintTemplates.title'),
                  })}
                >
                  {t('automationsPage.hintTemplates.subtitle')}
                </InfoTip>
              </p>
              {/* GROUPED BY MOMENT, not listed.

                  Eight cards read as a list. Twenty-one read as nothing at all
                  unless the moments they belong to are visible — and the moment
                  is what an operator is shopping for, not the event name. The
                  stages are the customer's life in the order it happens, and
                  they are the same lanes the trigger map draws. */}
              {HINT_TEMPLATE_STAGES.map((stage) => {
                const inStage = HINT_TEMPLATES.filter((tpl) => tpl.stage === stage);
                if (inStage.length === 0) return null;
                // THE TWO WELCOMES ARE ONE CARD with a choice of whom it greets
                // (`arrival-template-card.tsx`): as two cards, the only thing
                // telling them apart was an event code under each title.
                const hasArrival = inStage.some(isArrivalTemplate);
                const cards = inStage.filter((tpl) => !isArrivalTemplate(tpl));
                return (
                  <div key={stage} className="space-y-1.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {t(`automationsPage.hintTemplates.stages.${stage}`)}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {hasArrival && (
                        <ArrivalTemplateCard
                          onUse={onUseHintTemplate}
                          pending={hintTemplatePending}
                        />
                      )}
                      {cards.map((tpl) => (
                        <div key={tpl.id} className="flex flex-col rounded-lg border p-3">
                          <p className="text-xs font-medium">
                            {t(`automationsPage.hintTemplates.${tpl.id}.name`)}
                          </p>
                          <p className="mt-0.5 mb-2 flex-1 text-[11px] text-muted-foreground">
                            {t(`automationsPage.hintTemplates.${tpl.id}.description`)}
                          </p>
                          <code className="mb-2 truncate text-[10px] text-muted-foreground">
                            {tpl.triggerSpec}
                          </code>
                          <ButtonTip
                            tip={t('automationsPage.tips.useHintTemplate')}
                            disabled={hintTemplatePending}
                            className="flex [&>*]:flex-1"
                          >
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={hintTemplatePending}
                              onClick={() => onUseHintTemplate({ template: tpl, companions: [] })}
                            >
                              <Plus className="mr-1.5 h-3.5 w-3.5" />
                              {t('automationsPage.help.useTemplate')}
                            </Button>
                          </ButtonTip>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function RuleList({
  rules,
  loading,
  actionPermissions,
  selectedId,
  onSelect,
  onToggle,
}: {
  rules: AutomationRule[];
  loading: boolean;
  actionPermissions: ActionPermissionMap | undefined;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string, isEnabled: boolean) => void;
}) {
  const { t } = useTranslation();
  // Switching a rule ON asks the admin for every permission its actions need;
  // switching it OFF asks for nothing. So the switch of a rule that is off, and
  // that this role could not switch on, is held — and says why.
  const missingFor = useMissingActionPermissions(actionPermissions);
  if (loading) {
    return (
      <Card>
        <CardContent className="p-2 space-y-2">
          {Array.from({ length: 4 }).map((_, idx) => (
            <Skeleton key={idx} className="h-14 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-2 space-y-1">
        {rules.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {t('automationsPage.list.empty')}
          </div>
        ) : (
          rules.map((rule) => {
            const active = rule.id === selectedId;
            const missing = rule.isEnabled ? [] : missingFor(rule.actions);
            const switchOnBlocked = missing.length > 0;
            return (
              <div
                key={rule.id}
                className={cn(
                  'rounded-md transition-colors flex items-stretch gap-1',
                  active ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(rule.id)}
                  aria-current={active ? 'true' : undefined}
                  aria-label={t('automationsPage.list.selectAria', { name: rule.name })}
                  className="min-w-0 flex-1 text-left px-3 py-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{rule.name}</span>
                    <Badge variant={active ? 'secondary' : 'outline'} className="text-[10px]">
                      {t(`automationsPage.triggers.${rule.triggerKind.toLowerCase()}`, {
                        defaultValue: rule.triggerKind,
                      })}
                    </Badge>
                  </div>
                  <p className={cn('text-xs truncate mt-0.5', active ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
                    {t('automationsPage.list.runCount', { count: rule.runCount })}
                    {rule.lastRunStatus
                      ? t('automationsPage.list.lastRun', {
                          status: t(`automationsPage.statuses.${rule.lastRunStatus}`, {
                            defaultValue: rule.lastRunStatus.toLowerCase(),
                          }),
                        })
                      : ''}
                  </p>
                </button>
                <div className="flex items-center pr-3">
                  <ButtonTip
                    tip={
                      switchOnBlocked
                        ? t('automationsPage.tips.listToggleNeedsPermission', {
                            actions: actionsNeedingPermission(t, rule.actions, missingFor),
                            permissions: permissionList(t, missing),
                          })
                        : t('automationsPage.tips.listToggle')
                    }
                    disabled={switchOnBlocked}
                  >
                    <Switch
                      checked={rule.isEnabled}
                      onCheckedChange={(v) => onToggle(rule.id, v)}
                      disabled={switchOnBlocked}
                      aria-label={t('automationsPage.list.toggleAria', { name: rule.name })}
                    />
                  </ButtonTip>
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

interface RuleEditorProps {
  ruleId: string;
  /** The unsaved draft and its companions, when `ruleId` is `NEW_RULE_ID`. */
  draftSeed: DraftSeed | null;
  actionCatalog: readonly AutomationActionType[];
  /** What each action needs beyond the automations permissions; see `action-permissions.ts`. */
  actionPermissions: ActionPermissionMap | undefined;
  onSaved: (
    rule: AutomationRule,
    outcome: {
      readonly created: boolean;
      /** The editor's id when «Сохранить» or «Создать» was pressed. */
      readonly fromId: string;
      /** The draft's seed when «Создать» was pressed; `null` for a saved rule. */
      readonly fromSeed: AutomationRule | null;
    },
  ) => void;
  onDeleted: () => void;
  /** Takes the companion rules off the draft: «Создать» then saves only the draft. */
  onDropCompanions: () => void;
}

/** One companion rule «Создать» tried to save after the draft, and how that went. */
interface CompanionOutcome {
  readonly name: string;
  /** `null` when it was created. */
  readonly error: unknown;
}

/** How the editor's rule was read, for a saved rule; `null` for a draft. */
interface RuleLoad {
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => unknown;
}

/**
 * A draft is drawn from the page's seed and a saved rule from its query — two
 * components, so an unsaved draft never goes near the query cache at all.
 * Neither changes under one editor: the page keys the editor by `ruleId`.
 */
function RuleEditor(props: RuleEditorProps) {
  if (props.ruleId === NEW_RULE_ID) {
    return <RuleEditorBody {...props} rule={props.draftSeed?.rule} load={null} />;
  }
  return <SavedRuleEditor {...props} />;
}

function SavedRuleEditor(props: RuleEditorProps) {
  const ruleQuery = useQuery({
    queryKey: ['admin', 'automations', 'rule', props.ruleId],
    queryFn: () => getRule(props.ruleId),
  });
  return <RuleEditorBody {...props} rule={ruleQuery.data} load={ruleQuery} />;
}

function RuleEditorBody({
  ruleId,
  rule: ruleToEdit,
  load,
  draftSeed,
  actionCatalog,
  actionPermissions,
  onSaved,
  onDeleted,
  onDropCompanions,
}: RuleEditorProps & { rule: AutomationRule | undefined; load: RuleLoad | null }) {
  const { t } = useTranslation();
  const isNew = ruleId === NEW_RULE_ID;
  const queryClient = useQueryClient();
  const mayRun = useHasPermission('automations', 'run');
  // What the rule's actions need beyond the automations permissions, of this
  // admin: the server asks it on «Сохранить», on the switch and on «Запустить
  // сейчас», and the buttons say so before the press rather than after it.
  const missingFor = useMissingActionPermissions(actionPermissions);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runConfirmOpen, setRunConfirmOpen] = useState(false);
  // Where keyboard focus goes when the run dialog closes: back to the button it
  // was opened from, which Radix cannot do for a dialog with no trigger.
  const runButton = useRef<HTMLButtonElement>(null);
  const switchId = useId();

  // The rule under THIS id and the draft taken from it, as one value — never a
  // draft left over from the rule that was open before. `useRuleDraft` holds
  // the account of the render that took the whole page down after Create.
  const { inHand, setDraft } = useRuleDraft(ruleToEdit);

  const saveMutation = useMutation({
    mutationFn: async (): Promise<{
      rule: AutomationRule;
      companions: CompanionOutcome[];
      seedAtPress: AutomationRule | null;
    }> => {
      const draft = inHand?.draft;
      if (!draft) throw new Error('No draft');
      // The draft this press saves, taken NOW: the callbacks run with whatever
      // props the editor has when the answer lands, and by then the page may
      // have opened another draft in its place.
      const seedAtPress = isNew ? (draftSeed?.rule ?? null) : null;
      const payload: UpsertRulePayload = {
        ...draft,
        description: draft.description?.trim() ? draft.description.trim() : undefined,
      };
      if (!isNew) return { rule: await apiUpdateRule(ruleId, payload), companions: [], seedAtPress };
      // THE DRAFT FIRST, then each companion in order, each with the draft's
      // payload under its own name and event. A companion that fails does not
      // undo the rule already created, and does not stop the next one: they
      // are separate rules, and the answer says which of them exist.
      const rule = await apiCreateRule(payload);
      const companions: CompanionOutcome[] = [];
      for (const companion of companionsInForce(draft, draftSeed?.companions ?? [])) {
        try {
          await apiCreateRule(companionPayload(payload, companion));
          companions.push({ name: companion.name, error: null });
        } catch (error) {
          companions.push({ name: companion.name, error });
        }
      }
      return { rule, companions, seedAtPress };
    },
    onSuccess: ({ rule, companions, seedAtPress }) => {
      if (companions.length === 0) {
        toast.success(isNew ? t('automationsPage.toast.created') : t('automationsPage.toast.updated'));
      } else {
        const quoted = (name: string) => t('automationsPage.toast.ruleName', { name });
        const created = [rule.name, ...companions.filter((c) => c.error === null).map((c) => c.name)]
          .map(quoted)
          .join(', ');
        const failed = companions.filter((c) => c.error !== null);
        if (failed.length === 0) {
          // Off or on as the SERVER saved them — the switch in the header may
          // have been turned on before «Создать».
          toast.success(
            t(
              rule.isEnabled
                ? 'automationsPage.toast.createdSeveralOn'
                : 'automationsPage.toast.createdSeveralOff',
              { names: created },
            ),
          );
        } else {
          toast.error(
            t('automationsPage.toast.createdPartly', {
              created,
              failed: failed
                .map((c) =>
                  t('automationsPage.toast.ruleFailed', {
                    name: c.name,
                    message: translateAutomationError(t, c.error),
                  }),
                )
                .join('; '),
            }),
          );
        }
      }
      // The created draft is opened whatever became of its companions.
      onSaved(rule, { created: isNew, fromId: ruleId, fromSeed: seedAtPress });
    },
    // `translateAutomationError`, not `.message` and not `getErrorMessage`.
    //
    // An axios rejection's own message for a non-2xx is the literal string
    // "Request failed with status code 400", and the interceptor re-rejects the
    // original error unchanged for anything that is not a 401 — so every
    // refusal the server spends its design budget wording arrived as that
    // sentence. The save-time pop-up check names the events an operator can
    // bind to, and none of them reached anybody.
    //
    // `getErrorMessage` fixed that half and left the other: it falls through to
    // `.message` BEFORE its fallback, and every axios rejection has one, so the
    // translated fallback could never be reached and a Russian operator whose
    // backend was down read "Network Error". `translateApiError` decides in the
    // right order — the server's sentence first, then transport copy naming the
    // connection and the reverse proxy, then the generic — and looks the
    // server's own sentence up in the dictionary on the way past.
    //
    // `translateAutomationError` goes first for the refusals a save now meets
    // that carry values — the permission an action needs, where the conditions
    // went wrong, what a URL or an address points at — and hands everything
    // else to `translateApiError` as before.
    onError: (err) =>
      toast.error(
        t('automationsPage.toast.saveFailed', {
          message: translateAutomationError(t, err),
        }),
      ),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiDeleteRule(ruleId),
    onSuccess: () => {
      toast.success(t('automationsPage.toast.deleted'));
      onDeleted();
    },
    onError: (err) =>
      toast.error(
        t('automationsPage.toast.deleteFailed', {
          message: translateAutomationError(t, err),
        }),
      ),
  });

  // The immediate run, for a rule that shows no hint to a customer. A rule that
  // does opens `RuleRunDialog` instead — see there for why.
  const runMutation = useMutation({
    mutationFn: () => runRuleManually(ruleId, {}),
    onSuccess: (result) => {
      // THE STATUS IN THE OPERATOR'S LANGUAGE, and what went wrong first. It
      // printed the raw `SUCCEEDED` — and nothing at all about an action that
      // failed or was skipped inside a run graded as a whole.
      const text = runToastText(t, result);
      if (result.status === 'FAILED') toast.error(text);
      else if (result.status === 'SKIPPED') toast.warning(text);
      else toast.success(text);
      queryClient.invalidateQueries({ queryKey: ['admin', 'automations'] });
    },
    onError: (err) => {
      // AN UNANSWERED RUN IS NOT A FAILED ONE. The run executes inside the
      // request; a timeout or no answer at all may belong to a run that is still
      // going, and "failed" invites pressing again — a second run. Its row will
      // say how it ended, so the rule and its log are read again.
      if (runHadNoAnswer(err)) {
        toast.warning(t('automationsPage.toast.runNoAnswer'));
        void queryClient.invalidateQueries({ queryKey: ['admin', 'automations'] });
        return;
      }
      toast.error(
        t('automationsPage.toast.runFailed', {
          message: translateAutomationError(t, err),
        }),
      );
    },
  });

  if (!inHand) {
    // A READ THAT FAILED SAYS SO. The skeleton used to stay up for ever: reads
    // are not retried, and clicking the rule again changes nothing, because it
    // is already the selected one. Pressing retry puts the skeleton back until
    // the new answer.
    if (load?.isError) {
      return (
        <Card>
          <CardContent className="p-6">
            <Alert variant="destructive">
              <AlertTitle>{t('automationsPage.errors.title')}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{translateAutomationError(t, load.error)}</p>
                <Button variant="outline" size="sm" onClick={() => void load.refetch()}>
                  {t('common.retry')}
                </Button>
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      );
    }
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }
  const { rule, draft } = inHand;
  // NOTHING IS TYPED INTO A RULE WHILE IT IS BEING SAVED. The answer to
  // «Сохранить» becomes the rule's copy (`onSaved`), and a copy whose content
  // moved starts the draft over (`useRuleDraft`): whatever was typed or
  // switched after the payload left vanished without a word when the answer
  // landed. «Создать» opens the created rule in an editor of its own, which
  // had always dropped it. So the switch and every field take no input until
  // the answer is in; a save that fails gives them back with the draft intact.
  const saving = saveMutation.isPending;
  // Companions still in force for the draft as it stands (`rule-companions.ts`).
  const companions = isNew ? companionsInForce(draft, draftSeed?.companions ?? []) : [];
  // A rule that shows a hint to the customer its event names cannot run for
  // nobody, so its «Запустить сейчас» asks whom to run it for. Read off the
  // SAVED rule: the run executes what is on the server, not the draft.
  const runAsksForCustomer = !isNew && rule.actions.some((action) => action.type === 'show_hint');
  // Read off the SAVED rule, like the two above: the run executes what is on
  // the server, and the server asks this admin for every action's permission.
  const runMissing = isNew ? [] : missingFor(rule.actions);
  const runBlocked = !mayRun || runMissing.length > 0 || runMutation.isPending;
  // The DRAFT's actions: «Сохранить» sends them, and the server asks for the
  // permission of every one — a kept action as much as an added one.
  const saveMissing = missingFor(draft.actions);
  // ── «Запустить сейчас» ON A RULE THAT IS SWITCHED OFF ────────────────────
  //
  // A manual run IGNORES the switch (the executor stopped grading such a run
  // SKIPPED «rule disabled» in this release), and a rule with no `show_hint`
  // opens no dialog: one press ran it. So a rule switched off months ago — and
  // a rule is switched off precisely because it must not act — could ban a
  // customer, block an address or post a webhook on a single press, with the
  // one sentence that explains this living inside the dialog these rules never
  // open. Now the panel asks first, and the question names the rule, the
  // switch, and every action that is about to run.
  //
  // Read off the SAVED rule, like `runAsksForCustomer`: the run executes what
  // is on the server, not what is typed into the editor.
  const runNeedsConfirming = !isNew && !runAsksForCustomer && rule.isEnabled === false;
  const blockingActions = rule.actions
    .filter((action) => action.type === 'block_user' || action.type === 'block_ip')
    .map((action) => actionLabel(t, action.type));
  // AN AUDIENCE ACTION WITH NO AUDIENCE. The server refuses the whole rule for
  // it, and the refusal names neither the action nor the field, so the operator
  // was left to guess which of several actions it meant. The panel knows before
  // the press: the picker is marked, and «Сохранить» says what is missing
  // instead of sending a save that cannot succeed.
  const audienceMissing = draft.actions.some(
    (action) =>
      action.type === 'show_hint_to_audience' &&
      (typeof action.params?.audience !== 'string' || action.params.audience.trim().length === 0),
  );

  return (
    <Card>
      <CardHeader className="space-y-1.5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <CardTitle>{isNew ? t('automationsPage.editor.newTitle') : draft.name}</CardTitle>
            <div className="flex items-center gap-2">
              <Switch
                id={switchId}
                checked={draft.isEnabled ?? false}
                onCheckedChange={(v) => setDraft({ ...draft, isEnabled: v })}
                disabled={saving}
              />
              <LabelWithInfo
                htmlFor={switchId}
                info={t('automationsPage.editor.enabledInfo')}
                infoLabel={t('automationsPage.infoAria', {
                  subject: t('automationsPage.editor.enabledLabel'),
                })}
              >
                {t('automationsPage.editor.enabledLabel')}
              </LabelWithInfo>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isNew && (
              <ButtonTip
                tip={
                  !mayRun
                    ? t('automationsPage.tips.runNowForbidden')
                    : runMissing.length > 0
                      ? t('automationsPage.tips.runNowNeedsPermission', {
                          actions: actionsNeedingPermission(t, rule.actions, missingFor),
                          permissions: permissionList(t, runMissing),
                        })
                      : runAsksForCustomer
                        ? t('automationsPage.tips.runNowDialog')
                        : runNeedsConfirming
                          ? t('automationsPage.tips.runNowOffConfirm')
                          : t('automationsPage.tips.runNow')
                }
                disabled={runBlocked}
              >
                <Button
                  ref={runButton}
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (runAsksForCustomer) {
                      setRunDialogOpen(true);
                      return;
                    }
                    if (runNeedsConfirming) {
                      setRunConfirmOpen(true);
                      return;
                    }
                    runMutation.mutate();
                  }}
                  disabled={runBlocked}
                >
                  {runMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <PlayCircle className="mr-2 h-4 w-4" />
                  )}
                  {t('automationsPage.editor.runNow')}
                </Button>
              </ButtonTip>
            )}
            {runAsksForCustomer && (
              <RuleRunDialog
                open={runDialogOpen}
                onOpenChange={setRunDialogOpen}
                rule={rule}
                returnFocusTo={runButton}
              />
            )}
            {runNeedsConfirming && (
              <AlertDialog open={runConfirmOpen} onOpenChange={setRunConfirmOpen}>
                <AlertDialogContent
                  onCloseAutoFocus={(event) => {
                    // Back to the button that opened it, as the run dialog does:
                    // nothing here is a Radix trigger, so focus would fall to the
                    // page body and the next Tab would start from the top.
                    const opener = runButton.current;
                    if (opener === null) return;
                    event.preventDefault();
                    opener.focus();
                  }}
                >
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('automationsPage.runConfirm.title')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('automationsPage.runConfirm.body', { name: rule.name })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  {/* The switch in the editor is not the switch that decides:
                      a run executes the SAVED rule. Said only when the two
                      disagree, which is the case an operator can misread. */}
                  {draft.isEnabled === true && (
                    <p className="text-sm text-muted-foreground">
                      {t('automationsPage.runConfirm.unsavedSwitch')}
                    </p>
                  )}
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{t('automationsPage.runConfirm.actionsTitle')}</p>
                    <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                      {rule.actions.map((action, index) => (
                        <li key={`${action.type}-${index}`}>{actionLabel(t, action.type)}</li>
                      ))}
                    </ul>
                  </div>
                  {blockingActions.length > 0 && (
                    <p className="text-sm font-medium text-destructive">
                      {t('automationsPage.runConfirm.blockWarning', { actions: blockingActions.join(', ') })}
                    </p>
                  )}
                  <AlertDialogFooter>
                    <ButtonTip tip={t('automationsPage.runConfirm.cancelTip')}>
                      <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    </ButtonTip>
                    <ButtonTip tip={t('automationsPage.runConfirm.confirmTip')}>
                      <AlertDialogAction onClick={() => runMutation.mutate()}>
                        {t('automationsPage.runConfirm.confirm')}
                      </AlertDialogAction>
                    </ButtonTip>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <ButtonTip
              tip={
                audienceMissing
                  ? t('automationsPage.tips.saveNeedsAudience')
                  : saveMissing.length > 0
                    ? t('automationsPage.tips.saveNeedsPermission', {
                        actions: actionsNeedingPermission(t, draft.actions, missingFor),
                        permissions: permissionList(t, saveMissing),
                      })
                    : isNew
                      ? companions.length > 0
                        ? t('automationsPage.tips.createWithCompanions')
                        : t('automationsPage.tips.create')
                      : t('automationsPage.tips.save')
              }
              disabled={saveMutation.isPending || audienceMissing || saveMissing.length > 0}
            >
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending || audienceMissing || saveMissing.length > 0}
              >
                {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isNew ? t('automationsPage.editor.create') : t('automationsPage.editor.save')}
              </Button>
            </ButtonTip>
            {!isNew && (
              <AlertDialog>
                <ButtonTip tip={t('automationsPage.tips.delete')} disabled={deleteMutation.isPending}>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t('automationsPage.editor.delete')}
                    </Button>
                  </AlertDialogTrigger>
                </ButtonTip>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t('automationsPage.editor.delete')}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('automationsPage.editor.deleteConfirm', { name: draft.name })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={deleteMutation.isPending}>
                      {t('common.cancel')}
                    </AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      disabled={deleteMutation.isPending}
                      onClick={() => deleteMutation.mutate()}
                    >
                      {t('automationsPage.editor.delete')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>
        <CardDescription>
          {isNew
            ? t('automationsPage.editor.newDescription')
            : t('automationsPage.editor.existingDescription', {
                createdAt: formatDateTime(rule.createdAt),
                runCount: rule.runCount,
              })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <RuleCompanionsNotice companions={companions} onDrop={onDropCompanions} disabled={saving} />
        <Tabs defaultValue="config">
          <TabsList>
            <TabsTrigger value="config">{t('automationsPage.editor.tabs.config')}</TabsTrigger>
            {!isNew && <TabsTrigger value="executions">{t('automationsPage.editor.tabs.executions')}</TabsTrigger>}
          </TabsList>
          <TabsContent value="config" className="space-y-4 pt-4">
            <ConfigEditor
              draft={draft}
              setDraft={setDraft}
              actionCatalog={actionCatalog}
              missingFor={missingFor}
              ruleId={isNew ? undefined : ruleId}
              savedActions={isNew ? [] : rule.actions}
              companions={companions}
              disabled={saving}
            />
          </TabsContent>
          {!isNew && (
            <TabsContent value="executions" className="pt-4">
              <ExecutionsList ruleId={ruleId} />
            </TabsContent>
          )}
        </Tabs>
      </CardContent>
    </Card>
  );
}

function ConfigEditor({
  draft,
  setDraft,
  actionCatalog,
  missingFor,
  ruleId,
  savedActions,
  companions,
  disabled,
}: {
  draft: UpsertRulePayload;
  setDraft: (next: UpsertRulePayload) => void;
  actionCatalog: readonly AutomationActionType[];
  /** The permissions actions need that this admin lacks; see `action-permissions.ts`. */
  missingFor: (actions: ReadonlyArray<{ readonly type: string }>) => PermissionRef[];
  /** Undefined for an unsaved draft — it cannot collide with itself. */
  ruleId?: string;
  /** The actions as SAVED — what a kept header's reference names. Empty for a draft. */
  savedActions: readonly AutomationActionDef[];
  /** The companion rules «Создать» saves with this draft, each on its own event. */
  companions: readonly DraftCompanion[];
  /** True while the rule is being saved: every control here takes no input. */
  disabled: boolean;
}) {
  const { t } = useTranslation();
  /** The accessible name of the (i) beside a field: «Подробнее: Название». */
  const infoAria = (subject: string): string => t('automationsPage.infoAria', { subject });
  // Read HERE rather than threaded down from the page: nothing above the field
  // decides anything about it, and a sixth prop for one query would put the
  // catalogue's lifetime in a component that never looks at it.
  const eventCatalogQuery = useQuery({
    queryKey: ['admin', 'automations', 'events'],
    queryFn: getEventCatalog,
    // ONLY FOR A REALTIME RULE. The hint is drawn for no other kind, and this
    // query groups over the audit log — the busiest table in the schema. Firing
    // it while somebody edits a nightly cron is a full scan for an answer the
    // page will not show.
    enabled: draft.triggerKind === 'REALTIME',
    // The answer moves slowly, being a retention-window count.
    staleTime: 10 * 60 * 1000,
  });
  const eventCatalog = eventCatalogQuery.data;
  const conditionsText = useMemo(
    () => (draft.conditions ? JSON.stringify(draft.conditions, null, 2) : ''),
    [draft.conditions],
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <LabelWithInfo
            htmlFor="automation-rule-name"
            info={t('automationsPage.config.nameInfo')}
            infoLabel={infoAria(t('automationsPage.config.name'))}
          >
            {t('automationsPage.config.name')}
          </LabelWithInfo>
          <Input
            id="automation-rule-name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            maxLength={96}
            disabled={disabled}
          />
        </div>
        <div className="space-y-1.5">
          <LabelWithInfo
            info={t('automationsPage.config.triggerInfo')}
            infoLabel={infoAria(t('automationsPage.config.trigger'))}
          >
            {t('automationsPage.config.trigger')}
          </LabelWithInfo>
          <Select
            value={draft.triggerKind}
            onValueChange={(v) => setDraft({ ...draft, triggerKind: v as AutomationTriggerKind })}
            disabled={disabled}
          >
            <SelectTrigger aria-label={t('automationsPage.config.trigger')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="REALTIME">{t('automationsPage.triggers.realtime')}</SelectItem>
              <SelectItem value="CRON">{t('automationsPage.triggers.cron')}</SelectItem>
              <SelectItem value="MANUAL">{t('automationsPage.triggers.manual')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <LabelWithInfo
          htmlFor="automation-rule-description"
          info={t('automationsPage.config.descriptionInfo')}
          infoLabel={infoAria(t('automationsPage.config.description'))}
        >
          {t('automationsPage.config.description')}
        </LabelWithInfo>
        <Textarea
          id="automation-rule-description"
          value={draft.description ?? ''}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          rows={2}
          maxLength={512}
          disabled={disabled}
        />
      </div>

      {draft.triggerKind !== 'MANUAL' && (
        <div className="space-y-1.5">
          <LabelWithInfo
            htmlFor="automation-trigger-spec"
            info={
              draft.triggerKind === 'REALTIME'
                ? t('automationsPage.config.eventPatternHint')
                : t('automationsPage.config.cronHint')
            }
            infoLabel={infoAria(
              draft.triggerKind === 'REALTIME'
                ? t('automationsPage.config.eventPattern')
                : t('automationsPage.config.cronExpression'),
            )}
          >
            {draft.triggerKind === 'REALTIME' ? t('automationsPage.config.eventPattern') : t('automationsPage.config.cronExpression')}
          </LabelWithInfo>
          <Input
            id="automation-trigger-spec"
            value={draft.triggerSpec}
            onChange={(e) => setDraft({ ...draft, triggerSpec: e.target.value })}
            placeholder={
              draft.triggerKind === 'REALTIME'
                ? t('automationsPage.config.eventPatternPlaceholder')
                : t('automationsPage.config.cronPlaceholder')
            }
            maxLength={256}
            disabled={disabled}
          />
          {/* WHAT THIS TRIGGER HAS ACTUALLY DONE HERE. The field is free text
              against a panel that declares 115 event types and emits fewer, and
              a rule bound to one nothing emits fails in perfect silence — no
              execution row, no error, no log line, "enabled" for ever. */}
          {draft.triggerKind === 'REALTIME' && (
            <TriggerCatalogHint
              spec={draft.triggerSpec}
              events={eventCatalog?.events ?? []}
              windowDays={eventCatalog?.windowDays ?? 0}
            />
          )}
        </div>
      )}

      <Separator />

      <div className="space-y-1.5">
        <LabelWithInfo
          htmlFor="automation-conditions"
          info={t('automationsPage.help.conditionsHint')}
          infoLabel={infoAria(t('automationsPage.config.conditionsLabel'))}
        >
          {t('automationsPage.config.conditionsLabel')}
        </LabelWithInfo>
        <Textarea
          id="automation-conditions"
          value={conditionsText}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw.trim().length === 0) {
              setDraft({ ...draft, conditions: null });
              return;
            }
            try {
              setDraft({ ...draft, conditions: JSON.parse(raw) });
            } catch {
              // Ignore parse errors mid-typing — the user gets a chance to
              // finish the JSON. We could highlight the error but for now
              // we just keep the previous valid value.
            }
          }}
          rows={6}
          placeholder={t('automationsPage.config.examplePlaceholder', {
            example: `{\n  "and": [\n    { "==": ["$severity", "HIGH"] },\n    { ">": ["$score", 70] }\n  ]\n}`,
          })}
          className="font-mono text-xs"
          disabled={disabled}
        />
      </div>

      <Separator />

      <ActionsEditor
        actions={draft.actions}
        savedActions={savedActions}
        actionCatalog={actionCatalog}
        missingFor={missingFor}
        onChange={(actions) => setDraft({ ...draft, actions })}
        triggerKind={draft.triggerKind}
        triggerSpec={draft.triggerSpec}
        companions={companions}
        disabled={disabled}
      />

      <HintCollisionNotice
        ruleId={ruleId}
        draft={draft}
        companionTriggerSpecs={companions.map((companion) => companion.triggerSpec)}
      />
    </div>
  );
}

/**
 * Says when saving this rule will put a SECOND window in front of the same
 * customer for the same act.
 *
 * A first purchase through a referral link with a promo code emits four events
 * within a second or two; a hint on each is four modals, and a customer who
 * meets four learns to close them unread. The queue's group already collapses
 * that — what it cannot do is tell the operator they needed one.
 *
 * It warns and does not refuse. Two hints for one purchase, shown one per
 * visit, is a defensible sequence; it is only a mistake when nobody meant it.
 */
function HintCollisionNotice({
  ruleId,
  draft,
  companionTriggerSpecs,
}: {
  ruleId: string | undefined;
  draft: UpsertRulePayload;
  /** The companion rules' events: «Создать» puts the draft's hint on those too. */
  companionTriggerSpecs: readonly string[];
}) {
  const { t } = useTranslation();
  const rulesQuery = useQuery({ queryKey: RULES_KEY, queryFn: listRules });
  const hintsQuery = useQuery({
    queryKey: ['admin', 'user-hints'],
    queryFn: listUserHints,
    staleTime: 5 * 60 * 1000,
  });
  const catalogQuery = useQuery({
    queryKey: ['admin', 'automations', 'catalog'],
    queryFn: getCatalog,
    staleTime: 5 * 60 * 1000,
  });

  const collisions = findHintCollisionsWithCompanions(
    {
      draft: {
        id: ruleId,
        triggerKind: draft.triggerKind,
        triggerSpec: draft.triggerSpec ?? '',
        actions: draft.actions,
      },
      rules: rulesQuery.data ?? [],
      hints: hintsQuery.data ?? [],
      coincidentEventGroups: catalogQuery.data?.coincidentEventGroups ?? [],
    },
    companionTriggerSpecs,
  );

  if (collisions.length === 0) return null;

  return (
    <Alert>
      <AlertTitle>{t('automationsPage.hintCollision.title')}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{t('automationsPage.hintCollision.body', { count: collisions.length })}</p>
        <ul className="list-disc pl-4 text-sm">
          {collisions.map((collision) => (
            <li key={`${collision.ruleId}:${collision.hintTitle}`}>
              <span className="font-medium">{collision.ruleName}</span>
              {' — '}
              <code className="text-xs">{collision.triggerSpec}</code>
              {' — '}
              {collision.hintTitle}
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          {t('automationsPage.hintCollision.fix')}
        </p>
      </AlertDescription>
    </Alert>
  );
}

function ActionsEditor({
  actions,
  savedActions,
  actionCatalog,
  missingFor,
  onChange,
  triggerKind,
  triggerSpec,
  companions,
  disabled,
}: {
  actions: AutomationActionDef[];
  /** The actions as saved: a kept `Authorization` header may not leave its saved URL's origin. */
  savedActions: readonly AutomationActionDef[];
  actionCatalog: readonly AutomationActionType[];
  /** The permissions actions need that this admin lacks: such a type is offered greyed out, with why. */
  missingFor: (actions: ReadonlyArray<{ readonly type: string }>) => PermissionRef[];
  onChange: (actions: AutomationActionDef[]) => void;
  /** The draft's trigger: the warnings under a hint picker compare the hint with it. */
  triggerKind: AutomationTriggerKind;
  triggerSpec: string;
  /** The companion rules: they show the same hint, each on its own event. */
  companions: readonly DraftCompanion[];
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const idPrefix = useId();
  const infoAria = (subject: string): string => t('automationsPage.infoAria', { subject });
  // The hint library, for the picker below. Loaded here rather than passed in:
  // only this editor needs it, and only when a `show_hint` action is present.
  const hintsQuery = useQuery({
    queryKey: ['admin', 'user-hints'],
    queryFn: listUserHints,
    staleTime: 5 * 60 * 1000,
  });
  function update(idx: number, next: AutomationActionDef) {
    const copy = actions.slice();
    copy[idx] = next;
    onChange(copy);
  }
  function remove(idx: number) {
    onChange(actions.filter((_, i) => i !== idx));
  }
  function add() {
    // The first type this admin may actually save — a new action that would
    // only ever grey out «Сохранить» is not a starting point.
    const allowed = actionCatalog.find((type) => missingFor([{ type }]).length === 0);
    onChange([
      ...actions,
      { type: allowed ?? actionCatalog[0] ?? 'notify_telegram', params: {} },
    ]);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold">{t('automationsPage.actions.heading')}</h3>
          <InfoTip label={infoAria(t('automationsPage.actions.heading'))}>
            {t('automationsPage.actions.headingInfo')}
          </InfoTip>
        </div>
        <ButtonTip tip={t('automationsPage.tips.addAction')} disabled={disabled}>
          <Button size="sm" variant="outline" onClick={add} disabled={disabled}>
            <Plus className="mr-2 h-4 w-4" />
            {t('automationsPage.actions.add')}
          </Button>
        </ButtonTip>
      </div>
      {actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('automationsPage.actions.required')}
        </p>
      ) : (
        actions.map((action, idx) => {
          const typeLabel = ACTION_LABEL_KEYS[action.type] ? t(ACTION_LABEL_KEYS[action.type]) : action.type;
          const typeDescription = t(`automationsPage.help.actionDescriptions.${action.type}`, {
            defaultValue: '',
          });
          const hintKey = typeof action.params?.hintKey === 'string' ? action.params.hintKey : '';
          const hintPickerId = `${idPrefix}-hint-${idx}`;
          const audiencePickerId = `${idPrefix}-audience-${idx}`;
          // Nothing picked yet — the state «Сохранить» waits for.
          const audienceEmpty =
            action.type === 'show_hint_to_audience' &&
            (typeof action.params?.audience !== 'string' || action.params.audience.trim().length === 0);
          return (
          <Card key={idx} className="bg-muted/30">
            <CardContent className="p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Select
                  value={action.type}
                  onValueChange={(v) => update(idx, { ...action, type: v })}
                  disabled={disabled}
                >
                  <SelectTrigger
                    className="max-w-xs"
                    aria-label={`${t('automationsPage.actions.heading')} ${idx + 1}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {actionCatalog.map((type) => {
                      const label = ACTION_LABEL_KEYS[type] ? t(ACTION_LABEL_KEYS[type]) : type;
                      const missing = missingFor([{ type }]);
                      if (missing.length === 0) {
                        return (
                          <SelectItem key={type} value={type}>
                            {label}
                          </SelectItem>
                        );
                      }
                      return (
                        <ForbiddenActionItem
                          key={type}
                          value={type}
                          label={label}
                          reason={t('automationsPage.tips.actionNeedsPermission', {
                            permissions: permissionList(t, missing),
                          })}
                        />
                      );
                    })}
                  </SelectContent>
                </Select>
                {/* What the SELECTED type does — the guide's sentence for it. */}
                {typeDescription.length > 0 && (
                  <InfoTip label={infoAria(typeLabel)}>
                    {t('automationsPage.actions.typeInfo', {
                      label: typeLabel,
                      description: typeDescription,
                    })}
                  </InfoTip>
                )}
                <ButtonTip tip={t('automationsPage.tips.removeAction')} disabled={disabled} className="ml-auto">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => remove(idx)}
                    className="ml-auto"
                    aria-label={t('automationsPage.actions.removeAria', { index: idx + 1 })}
                    disabled={disabled}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </ButtonTip>
              </div>
              {action.type === 'show_hint' || action.type === 'show_hint_to_audience' ? (
                /* CHOSEN, NOT TYPED. The parameter is a hint KEY, and an
                   operator asked to remember one and retype it into JSON will
                   sooner or later name a hint that does not exist — which the
                   engine can only report by logging, run after run, while the
                   rule quietly does nothing. */
                <div className="space-y-1.5">
                  {action.type === 'show_hint' ? (
                    <LabelWithInfo
                      htmlFor={hintPickerId}
                      info={t('automationsPage.actions.hintNeedsCustomer')}
                      infoLabel={infoAria(t('automationsPage.actions.hintLabel'))}
                    >
                      {t('automationsPage.actions.hintLabel')}
                    </LabelWithInfo>
                  ) : (
                    <LabelWithInfo htmlFor={hintPickerId}>
                      {t('automationsPage.actions.hintLabel')}
                    </LabelWithInfo>
                  )}
                  <Select
                    value={hintKey}
                    onValueChange={(v) =>
                      update(idx, {
                        ...action,
                        // The other params are KEPT. An audience action carries
                        // its audience name and window alongside the hint, and
                        // replacing the whole object on every pick would silently
                        // reset them to defaults.
                        params: { ...action.params, hintKey: v },
                      })
                    }
                    disabled={disabled}
                  >
                    <SelectTrigger id={hintPickerId}>
                      <SelectValue placeholder={t('automationsPage.actions.pickHint')} />
                    </SelectTrigger>
                    <SelectContent>
                      {(hintsQuery.data ?? []).map((hint) => (
                        <SelectItem key={hint.id} value={hint.key}>
                          {hint.titleRu}
                          {!hint.isActive && ` — ${t('userHints.off')}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <RuleHintWarnings
                    hint={(hintsQuery.data ?? []).find((hint) => hint.key === hintKey.trim())}
                    actionType={action.type}
                    triggerKind={triggerKind}
                    triggerSpec={triggerSpec}
                    companions={companions}
                  />
                  {action.type === 'show_hint_to_audience' && (
                    <>
                      <LabelWithInfo
                        htmlFor={audiencePickerId}
                        info={t('automationsPage.actions.audienceNeedsCron')}
                        infoLabel={infoAria(t('automationsPage.actions.audienceLabel'))}
                      >
                        {t('automationsPage.actions.audienceLabel')}
                      </LabelWithInfo>
                      <Select
                        value={
                          typeof action.params?.audience === 'string'
                            ? action.params.audience
                            : ''
                        }
                        onValueChange={(v) =>
                          update(idx, { ...action, params: { ...action.params, audience: v } })
                        }
                        disabled={disabled}
                      >
                        <SelectTrigger
                          id={audiencePickerId}
                          aria-invalid={audienceEmpty || undefined}
                          aria-describedby={audienceEmpty ? `${audiencePickerId}-missing` : undefined}
                          className={audienceEmpty ? 'border-destructive' : undefined}
                        >
                          <SelectValue placeholder={t('automationsPage.actions.pickAudience')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="paid-not-connected">
                            {t('automationsPage.audiences.paid-not-connected')}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      {audienceEmpty && (
                        <p id={`${audiencePickerId}-missing`} className="text-xs text-destructive">
                          {t('automationsPage.actions.audienceMissing')}
                        </p>
                      )}
                    </>
                  )}
                </div>
              ) : (
              <>
              {/* WITHOUT THE HEADER. `authorizationHeader` is write-only: the
                  panel sends a reference in its place, which this box must
                  neither show nor let anyone retype (`saved-header.ts`). The
                  field below holds it; an edit here puts it back unchanged. */}
              <Textarea
                value={JSON.stringify(paramsWithoutHeader(action.params), null, 2)}
                onChange={(e) => {
                  try {
                    const typed = JSON.parse(e.target.value) as Record<string, unknown>;
                    update(idx, { ...action, params: paramsWithHeaderKept(typed, action.params) });
                  } catch {
                    // Keep last valid params; a parse error mid-typing
                    // would otherwise discard the user's input.
                  }
                }}
                rows={5}
                className="font-mono text-xs"
                placeholder={t('automationsPage.config.examplePlaceholder', { example: '{ "text": "Hello" }' })}
                disabled={disabled}
              />
              {action.type === 'webhook_post' && isUrlHidden(action.params) && (
                <p className="text-xs text-muted-foreground">{t('automationsPage.actions.urlHidden')}</p>
              )}
              {action.type === 'webhook_post' && (
                <WebhookHeaderField
                  id={`${idPrefix}-header-${idx}`}
                  value={action.params?.authorizationHeader}
                  position={idx}
                  url={action.params?.url}
                  savedUrl={savedUrlFor(action.params?.authorizationHeader, savedActions)}
                  disabled={disabled}
                  onChange={(next) =>
                    update(idx, { ...action, params: { ...action.params, authorizationHeader: next } })
                  }
                />
              )}
              </>
              )}
            </CardContent>
          </Card>
          );
        })
      )}
    </div>
  );
}

/**
 * An action type this admin may not save, offered all the same — greyed out and
 * unpickable, with the reason on hover (the item's `title`) and in words under
 * its name, so a keyboard, a screen reader and a phone get it too.
 *
 * Only the name is the `ItemText`, which is what the picker shows for a chosen
 * value: a rule that already holds such an action shows the action's name, not
 * the sentence. Radix skips a disabled item for pointer and keyboard selection
 * alike, so the only way into this type is a rule that already had it.
 */
function ForbiddenActionItem({ value, label, reason }: { value: string; label: string; reason: string }) {
  return (
    <SelectPrimitive.Item
      value={value}
      disabled
      title={reason}
      className="relative flex w-full cursor-not-allowed select-none flex-col items-start rounded-sm py-1.5 pl-8 pr-2 text-sm opacity-60 outline-none"
    >
      <span className="absolute left-2 top-2 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{label}</SelectPrimitive.ItemText>
      <span className="mt-0.5 text-xs text-muted-foreground">{reason}</span>
    </SelectPrimitive.Item>
  );
}

function ExecutionsList({ ruleId }: { ruleId: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'automations', 'executions', ruleId],
    queryFn: () => listExecutions(ruleId, { limit: 50 }),
  });
  if (isLoading || !data) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, idx) => (
          <Skeleton key={idx} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (data.items.length === 0) {
    return <p className="text-sm text-muted-foreground py-6 text-center">{t('automationsPage.executions.empty')}</p>;
  }
  return (
    <div className="space-y-2">
      {data.items.map((exec) => (
        <div key={exec.id} className="rounded-md border p-3 text-sm space-y-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ExecutionStatusBadge status={exec.status} />
              <code className="text-xs">{exec.trigger}</code>
            </div>
            <span className="text-xs text-muted-foreground">
              {formatDateTime(exec.createdAt)}
              {exec.durationMs !== null && ` · ${exec.durationMs}ms`}
            </span>
          </div>
          {/* The executor's reason in words, and no English line repeating the
              worded failures below (`executionLogNote`). */}
          {executionLogNote(t, exec) !== null && (
            <p className={cn('text-xs', exec.status === 'FAILED' ? 'text-destructive' : 'text-muted-foreground')}>
              {executionLogNote(t, exec)}
            </p>
          )}
          {exec.actionResults.length > 0 && (
            <ul className="text-xs text-muted-foreground space-y-0.5">
              {exec.actionResults.map((r) => (
                <li key={r.index} className="flex items-center gap-1.5">
                  {r.status === 'success' ? (
                    <CheckCircle2 className="h-3 w-3 text-green-500" />
                  ) : r.status === 'failed' ? (
                    <XCircle className="h-3 w-3 text-destructive" />
                  ) : (
                    <Clock className="h-3 w-3 text-muted-foreground" />
                  )}
                  <code className="text-[11px]">
                    {t(`automationsPage.actionTypes.${r.type}`, { defaultValue: r.type })}
                  </code>
                  {/* Worded from its code when it has one; a row written before
                      codes existed keeps the server's message. */}
                  {actionResultText(t, r) !== null && (
                    <span className="truncate">— {actionResultText(t, r)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
