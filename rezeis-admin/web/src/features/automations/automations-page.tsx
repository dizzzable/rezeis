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
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Clock,
  Loader2,
  PlayCircle,
  Plus,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';

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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/utils';
import { getErrorMessage } from '@/lib/http-errors';
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

const ACTION_LABEL_KEYS: Record<string, string> = {
  notify_telegram: 'automationsPage.actionTypes.notify_telegram',
  webhook_post: 'automationsPage.actionTypes.webhook_post',
  block_ip: 'automationsPage.actionTypes.block_ip',
  block_user: 'automationsPage.actionTypes.block_user',
  system_event: 'automationsPage.actionTypes.system_event',
};

export default function AutomationsPage() {
  const { t } = useTranslation();
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

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Auto-select the first rule once data is loaded. Uses the
  // "store-prev-prop in render" pattern to avoid an effect.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [selectInitialized, setSelectInitialized] = useState(false);
  if (!selectInitialized && rulesQuery.data && rulesQuery.data.length > 0) {
    setSelectInitialized(true);
    if (selectedId === null) setSelectedId(rulesQuery.data[0]?.id ?? null);
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Zap className="h-6 w-6" />
            {t('automationsPage.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('automationsPage.subtitle')}
          </p>
        </div>
        <Button
          onClick={() => {
            const blank: AutomationRule = {
              id: '',
              name: t('automationsPage.untitledRule'),
              description: null,
              isEnabled: false,
              triggerKind: 'REALTIME',
              triggerSpec: 'payment.failed',
              conditions: null,
              actions: [{ type: 'notify_telegram', params: { text: 'Triggered' } }],
              createdById: null,
              lastRunAt: null,
              lastRunStatus: null,
              lastRunMessage: null,
              runCount: 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            setSelectedId('__new__');
            // Cache the blank rule under the synthetic id so the editor
            // can pick it up without a network round-trip.
            queryClient.setQueryData(['admin', 'automations', 'rule', '__new__'], blank);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          {t('automationsPage.newRule')}
        </Button>
      </header>

      {rulesQuery.error && (
        <Alert variant="destructive">
          <AlertTitle>{t('automationsPage.errors.title')}</AlertTitle>
          <AlertDescription>{t('automationsPage.errors.loadRules')}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <RuleList
          rules={rulesQuery.data ?? []}
          loading={rulesQuery.isLoading}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onToggle={(id, enabled) => {
            void toggleRule(id, enabled)
              .then(() => {
                queryClient.invalidateQueries({ queryKey: RULES_KEY });
              })
              .catch((err) => {
                toast.error(getErrorMessage(err, t('automationsPage.toast.toggleFailed')));
                // Refetch to revert any optimistic Switch UI back to source of truth.
                queryClient.invalidateQueries({ queryKey: RULES_KEY });
              });
          }}
        />
        {selectedId === null ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              {t('automationsPage.selectPrompt')}
            </CardContent>
          </Card>
        ) : (
          <RuleEditor
            ruleId={selectedId}
            actionCatalog={catalogQuery.data?.actionTypes ?? []}
            onSaved={(rule) => {
              setSelectedId(rule.id);
              queryClient.invalidateQueries({ queryKey: RULES_KEY });
            }}
            onDeleted={() => {
              setSelectedId(null);
              queryClient.invalidateQueries({ queryKey: RULES_KEY });
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function RuleList({
  rules,
  loading,
  selectedId,
  onSelect,
  onToggle,
}: {
  rules: AutomationRule[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string, isEnabled: boolean) => void;
}) {
  const { t } = useTranslation();
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
                      {rule.triggerKind}
                    </Badge>
                  </div>
                  <p className={cn('text-xs truncate mt-0.5', active ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
                    {t('automationsPage.list.runCount', { count: rule.runCount })}
                    {rule.lastRunStatus ? t('automationsPage.list.lastRun', { status: rule.lastRunStatus.toLowerCase() }) : ''}
                  </p>
                </button>
                <div className="flex items-center pr-3">
                  <Switch
                    checked={rule.isEnabled}
                    onCheckedChange={(v) => onToggle(rule.id, v)}
                    aria-label={t('automationsPage.list.toggleAria', { name: rule.name })}
                  />
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function RuleEditor({
  ruleId,
  actionCatalog,
  onSaved,
  onDeleted,
}: {
  ruleId: string;
  actionCatalog: readonly AutomationActionType[];
  onSaved: (rule: AutomationRule) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const isNew = ruleId === '__new__';
  const queryClient = useQueryClient();

  const ruleQuery = useQuery({
    queryKey: ['admin', 'automations', 'rule', ruleId],
    queryFn: () => (isNew ? Promise.resolve(queryClient.getQueryData<AutomationRule>(['admin', 'automations', 'rule', ruleId])!) : getRule(ruleId)),
    enabled: !!ruleId,
  });

  const [draft, setDraft] = useState<UpsertRulePayload | null>(null);

  // Reset draft state whenever a different rule is loaded — using the
  // "store previous prop in state and adjust during render" pattern.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [ruleSnapshotKey, setRuleSnapshotKey] = useState<string | null>(null);
  const nextRuleKey = ruleQuery.data
    ? `${ruleQuery.data.id}|${ruleQuery.data.updatedAt}`
    : null;
  if (nextRuleKey !== ruleSnapshotKey) {
    setRuleSnapshotKey(nextRuleKey);
    if (!ruleQuery.data) {
      setDraft(null);
    } else {
      setDraft({
        name: ruleQuery.data.name,
        description: ruleQuery.data.description ?? '',
        isEnabled: ruleQuery.data.isEnabled,
        triggerKind: ruleQuery.data.triggerKind,
        triggerSpec: ruleQuery.data.triggerSpec,
        conditions: ruleQuery.data.conditions,
        actions: ruleQuery.data.actions,
      });
    }
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!draft) return Promise.reject(new Error('No draft'));
      const payload: UpsertRulePayload = {
        ...draft,
        description: draft.description?.trim() ? draft.description.trim() : undefined,
      };
      return isNew ? apiCreateRule(payload) : apiUpdateRule(ruleId, payload);
    },
    onSuccess: (rule) => {
      toast.success(isNew ? t('automationsPage.toast.created') : t('automationsPage.toast.updated'));
      onSaved(rule);
    },
    onError: (err) => toast.error(t('automationsPage.toast.saveFailed', { message: (err as Error).message })),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiDeleteRule(ruleId),
    onSuccess: () => {
      toast.success(t('automationsPage.toast.deleted'));
      onDeleted();
    },
    onError: (err) => toast.error(t('automationsPage.toast.deleteFailed', { message: (err as Error).message })),
  });

  const runMutation = useMutation({
    mutationFn: () => runRuleManually(ruleId, {}),
    onSuccess: (result) => {
      toast.success(t('automationsPage.toast.runFinished', { status: result.status }));
      queryClient.invalidateQueries({ queryKey: ['admin', 'automations'] });
    },
    onError: (err) => toast.error(t('automationsPage.toast.runFailed', { message: (err as Error).message })),
  });

  if (!draft) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="space-y-1.5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <CardTitle>{isNew ? t('automationsPage.editor.newTitle') : draft.name}</CardTitle>
            <Switch
              checked={draft.isEnabled ?? false}
              onCheckedChange={(v) => setDraft({ ...draft, isEnabled: v })}
            />
          </div>
          <div className="flex items-center gap-2">
            {!isNew && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => runMutation.mutate()}
                disabled={runMutation.isPending}
              >
                {runMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <PlayCircle className="mr-2 h-4 w-4" />
                )}
                {t('automationsPage.editor.runNow')}
              </Button>
            )}
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isNew ? t('automationsPage.editor.create') : t('automationsPage.editor.save')}
            </Button>
            {!isNew && (
              <AlertDialog>
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
                createdAt: formatDateTime(ruleQuery.data?.createdAt ?? ''),
                runCount: ruleQuery.data?.runCount ?? 0,
              })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="config">
          <TabsList>
            <TabsTrigger value="config">{t('automationsPage.editor.tabs.config')}</TabsTrigger>
            {!isNew && <TabsTrigger value="executions">{t('automationsPage.editor.tabs.executions')}</TabsTrigger>}
          </TabsList>
          <TabsContent value="config" className="space-y-4 pt-4">
            <ConfigEditor draft={draft} setDraft={setDraft} actionCatalog={actionCatalog} />
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
}: {
  draft: UpsertRulePayload;
  setDraft: (next: UpsertRulePayload) => void;
  actionCatalog: readonly AutomationActionType[];
}) {
  const { t } = useTranslation();
  const conditionsText = useMemo(
    () => (draft.conditions ? JSON.stringify(draft.conditions, null, 2) : ''),
    [draft.conditions],
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="automation-rule-name">{t('automationsPage.config.name')}</Label>
          <Input
            id="automation-rule-name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            maxLength={96}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t('automationsPage.config.trigger')}</Label>
          <Select
            value={draft.triggerKind}
            onValueChange={(v) => setDraft({ ...draft, triggerKind: v as AutomationTriggerKind })}
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
        <Label htmlFor="automation-rule-description">{t('automationsPage.config.description')}</Label>
        <Textarea
          id="automation-rule-description"
          value={draft.description ?? ''}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          rows={2}
          maxLength={512}
        />
      </div>

      {draft.triggerKind !== 'MANUAL' && (
        <div className="space-y-1.5">
          <Label htmlFor="automation-trigger-spec">
            {draft.triggerKind === 'REALTIME' ? t('automationsPage.config.eventPattern') : t('automationsPage.config.cronExpression')}
          </Label>
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
          />
          <p className="text-xs text-muted-foreground">
            {draft.triggerKind === 'REALTIME'
              ? t('automationsPage.config.eventPatternHint')
              : t('automationsPage.config.cronHint')}
          </p>
        </div>
      )}

      <Separator />

      <div className="space-y-1.5">
        <Label htmlFor="automation-conditions">{t('automationsPage.config.conditionsLabel')}</Label>
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
          placeholder={`{\n  "and": [\n    { "==": ["$severity", "HIGH"] },\n    { ">": ["$score", 70] }\n  ]\n}`}
          className="font-mono text-xs"
        />
      </div>

      <Separator />

      <ActionsEditor
        actions={draft.actions}
        actionCatalog={actionCatalog}
        onChange={(actions) => setDraft({ ...draft, actions })}
      />
    </div>
  );
}

function ActionsEditor({
  actions,
  actionCatalog,
  onChange,
}: {
  actions: AutomationActionDef[];
  actionCatalog: readonly AutomationActionType[];
  onChange: (actions: AutomationActionDef[]) => void;
}) {
  const { t } = useTranslation();
  function update(idx: number, next: AutomationActionDef) {
    const copy = actions.slice();
    copy[idx] = next;
    onChange(copy);
  }
  function remove(idx: number) {
    onChange(actions.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([
      ...actions,
      { type: actionCatalog[0] ?? 'notify_telegram', params: {} },
    ]);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('automationsPage.actions.heading')}</h3>
        <Button size="sm" variant="outline" onClick={add}>
          <Plus className="mr-2 h-4 w-4" />
          {t('automationsPage.actions.add')}
        </Button>
      </div>
      {actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('automationsPage.actions.required')}
        </p>
      ) : (
        actions.map((action, idx) => (
          <Card key={idx} className="bg-muted/30">
            <CardContent className="p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Select
                  value={action.type}
                  onValueChange={(v) => update(idx, { ...action, type: v })}
                >
                  <SelectTrigger
                    className="max-w-xs"
                    aria-label={`${t('automationsPage.actions.heading')} ${idx + 1}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {actionCatalog.map((type) => (
                      <SelectItem key={type} value={type}>
                        {ACTION_LABEL_KEYS[type] ? t(ACTION_LABEL_KEYS[type]) : type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => remove(idx)}
                  className="ml-auto"
                  aria-label={t('automationsPage.actions.removeAria', { index: idx + 1 })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <Textarea
                value={JSON.stringify(action.params ?? {}, null, 2)}
                onChange={(e) => {
                  try {
                    update(idx, { ...action, params: JSON.parse(e.target.value) as Record<string, unknown> });
                  } catch {
                    // Keep last valid params; a parse error mid-typing
                    // would otherwise discard the user's input.
                  }
                }}
                rows={5}
                className="font-mono text-xs"
                placeholder='{ "text": "Hello" }'
              />
            </CardContent>
          </Card>
        ))
      )}
    </div>
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
          {exec.errorMessage && (
            <p className="text-xs text-destructive">{exec.errorMessage}</p>
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
                  <code className="text-[11px]">{r.type}</code>
                  {r.message && <span className="truncate">— {r.message}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function ExecutionStatusBadge({ status }: { status: AutomationRule['lastRunStatus'] }) {
  const { t } = useTranslation();
  if (!status) return <Badge variant="outline">{t('automationsPage.statuses.UNKNOWN')}</Badge>;
  const label = String(t(`automationsPage.statuses.${status}`, status));
  switch (status) {
    case 'SUCCEEDED':
      return <Badge variant="success">{label}</Badge>;
    case 'FAILED':
      return <Badge variant="destructive">{label}</Badge>;
    case 'RUNNING':
    case 'PENDING':
      return <Badge variant="warning">{label}</Badge>;
    case 'SKIPPED':
      return <Badge variant="secondary">{label}</Badge>;
  }
}
