/**
 * The catalog editor for the cabinet's connect screen.
 *
 * Four levels deep — platform, app, step, button — and the shape of the editor
 * follows that rather than flattening it, because the nesting is what an
 * operator is actually reasoning about: "on Android, in Hiddify, at the add
 * step, this button".
 *
 * ── Correctness is the server's answer ───────────────────────────────────────
 *
 * Nothing here decides whether a catalog is valid. The API validates on the way
 * in — schema, icon sanitizer, and an audit for catalogs that parse and still
 * cannot be used — and this editor ASKS it (`validate`) rather than owning a
 * second copy of those rules. Two validators for one config drift, and the one
 * in the browser is the one that would quietly become the more permissive.
 *
 * So the draft is allowed to be broken while it is being typed. A platform with
 * no apps, an app with no name, a button with an empty label: all normal states
 * to be in for a minute, all refused on save, all reported with the path of the
 * row they are about.
 *
 * ── Why up/down buttons and not drag-and-drop ────────────────────────────────
 *
 * Order is content here — which app is offered first is a decision — so it has
 * to be editable. Two buttons work with a keyboard, work on a phone, and cannot
 * drop a row into the wrong platform, which is the failure mode of a
 * drag-and-drop tree four levels deep.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Copy,
  Plus,
  Save,
  Star,
  Trash2,
} from 'lucide-react';
import { useMemo, useState, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

import {
  BUTTON_KINDS,
  CONNECT_PAGE_KEYS,
  PLATFORM_IDS,
  SUBSCRIPTION_LINK_TOKEN,
  connectPageApi,
  emptyApp,
  emptyButton,
  emptyStep,
  issuesFromError,
  moveItem,
  removeAt,
  replaceAt,
  setAppAt,
  slugify,
  type ConnectApp,
  type ConnectButton,
  type ConnectPageConfig,
  type ConnectPageIssue,
  type ConnectPlatform,
  type ConnectStep,
  type LocalizedText,
} from './connect-page-api';

export function ConnectPageEditor(): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: CONNECT_PAGE_KEYS.all,
    queryFn: connectPageApi.get,
  });

  // The draft is an OVERRIDE, not a copy seeded from the query. Seeding it in
  // an effect meant a refetch could land between the fetch and the seed and
  // throw away what the operator had typed — and it made the first render show
  // an empty editor for a frame. Until something is edited, the query's value
  // is simply what is on screen.
  const [draft, setDraft] = useState<ConnectPageConfig | null>(null);
  const [issues, setIssues] = useState<ConnectPageIssue[]>([]);
  const config = draft ?? data?.config ?? null;

  const save = useMutation({
    mutationFn: (config: ConnectPageConfig) => connectPageApi.replace(config),
    onSuccess: ({ cleanedIcons }) => {
      // The server's copy is NOT written back over the draft. It used to be,
      // and everything typed while the request was in flight vanished under a
      // green "saved" toast — the Save button was disabled, the fields were not.
      setIssues([]);
      void queryClient.invalidateQueries({ queryKey: CONNECT_PAGE_KEYS.all });
      const cleaned = Object.keys(cleanedIcons);
      toast.success(t('connectPageEditor.saved'));
      // Told, not silently applied: the operator pasted markup and got back
      // something different, and finding that out later from a missing icon is
      // worse than a line saying so now.
      if (cleaned.length > 0) {
        toast.warning(t('connectPageEditor.iconsCleaned', { icons: cleaned.join(', ') }));
      }
    },
    onError: (error) => {
      const found = issuesFromError(error);
      setIssues(found);
      toast.error(
        found.length > 0
          ? t('connectPageEditor.refused', { count: found.length })
          : t('connectPageEditor.saveFailed'),
      );
    },
  });

  const check = useMutation({
    mutationFn: (config: ConnectPageConfig) => connectPageApi.validate(config),
    onSuccess: (result) => {
      setIssues([...result.issues]);
      if (result.ok) toast.success(t('connectPageEditor.checkClean'));
    },
    onError: () => toast.error(t('connectPageEditor.checkFailed')),
  });

  const iconKeys = useMemo(() => Object.keys(config?.icons ?? {}).sort(), [config?.icons]);

  if (isError || (!isLoading && config === null)) {
    // `retry: false` is the client default, so this is the only attempt. An
    // endless skeleton with no words was the previous answer to a 500.
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('connectPageEditor.loadFailed')}</CardTitle>
          <CardDescription>{t('connectPageEditor.loadFailedHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" disabled={isFetching} onClick={() => void refetch()}>
            {t('connectPageEditor.retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (isLoading || config === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const patch = (next: Partial<ConnectPageConfig>): void => {
    // Paths like `platforms[3].apps[2]` stop meaning what they meant the moment
    // anything is added, removed or reordered, and a red card pointing at the
    // wrong row is worse than no red card.
    setIssues([]);
    setDraft({ ...config, ...next });
  };

  const usedPlatformIds = config.platforms.map((platform) => platform.id);
  const freePlatformIds = PLATFORM_IDS.filter((id) => !usedPlatformIds.includes(id));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t('connectPageEditor.summary', {
            platforms: config.platforms.length,
            apps: config.platforms.reduce((sum, platform) => sum + platform.apps.length, 0),
          })}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => check.mutate(config)}
            disabled={check.isPending || save.isPending}
          >
            {t('connectPageEditor.check')}
          </Button>
          <Button onClick={() => save.mutate(config)} disabled={save.isPending || check.isPending}>
            <Save className="mr-2 h-4 w-4" /> {t('connectPageEditor.save')}
          </Button>
        </div>
      </div>

      {data?.corrupted !== null && data?.corrupted !== undefined && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              {t('connectPageEditor.corruptedTitle')}
            </CardTitle>
            <CardDescription>
              {t('connectPageEditor.corruptedHint', { reason: data.corrupted })}
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {issues.length > 0 && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              {t('connectPageEditor.issuesTitle')}
            </CardTitle>
            <CardDescription>{t('connectPageEditor.issuesHint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {issues.map((issue, index) => (
              <p key={index} className="text-sm">
                <code className="rounded bg-muted px-1 py-0.5 text-xs">{issue.path || '—'}</code>{' '}
                <span className="text-muted-foreground">{issue.message}</span>
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      {config.platforms.map((platform, index) => (
        <PlatformCard
          key={platform.id}
          platform={platform}
          iconKeys={iconKeys}
          canMoveUp={index > 0}
          canMoveDown={index < config.platforms.length - 1}
          onMove={(delta) => patch({ platforms: moveItem(config.platforms, index, delta) })}
          onRemove={() => patch({ platforms: removeAt(config.platforms, index) })}
          onChange={(next) => patch({ platforms: replaceAt(config.platforms, index, next) })}
        />
      ))}

      {freePlatformIds.length > 0 && (
        <Select
          value=""
          onValueChange={(id) =>
            patch({
              platforms: [
                ...config.platforms,
                { id, title: { ru: '', en: '' }, iconKey: null, apps: [] },
              ],
            })
          }
        >
          <SelectTrigger className="w-full sm:w-72">
            <SelectValue placeholder={t('connectPageEditor.addPlatform')} />
          </SelectTrigger>
          <SelectContent>
            {freePlatformIds.map((id) => (
              <SelectItem key={id} value={id}>
                {t(`connectPageEditor.platform.${id}`, { defaultValue: id })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <IconLibrary
        icons={config.icons}
        // Only what the SERVER has already cleaned may be drawn. Everything in
        // the draft that is not also in this map is a raw paste.
        sanitized={data?.config.icons ?? {}}
        onChange={(icons) => patch({ icons })}
        inUse={collectUsedIcons(config)}
      />
    </div>
  );
}

// ── Platform ─────────────────────────────────────────────────────────────────

function PlatformCard({
  platform,
  iconKeys,
  canMoveUp,
  canMoveDown,
  onMove,
  onRemove,
  onChange,
}: {
  platform: ConnectPlatform;
  iconKeys: readonly string[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onChange: (next: ConnectPlatform) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const takenIds = platform.apps.map((app) => app.id);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 py-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          <span className="truncate font-medium">
            {t(`connectPageEditor.platform.${platform.id}`, { defaultValue: platform.id })}
          </span>
          <Badge variant="secondary">
            {t('connectPageEditor.appCount', { count: platform.apps.length })}
          </Badge>
        </button>
        <Reorder
          canUp={canMoveUp}
          canDown={canMoveDown}
          onMove={onMove}
          onRemove={onRemove}
          removeLabel={t('connectPageEditor.removePlatform')}
        />
      </CardHeader>

      {open && (
        <CardContent className="space-y-4">
          <LocalizedField
            label={t('connectPageEditor.platformTitle')}
            value={platform.title}
            onChange={(title) => onChange({ ...platform, title })}
          />
          <IconPicker
            label={t('connectPageEditor.icon')}
            value={platform.iconKey ?? null}
            keys={iconKeys}
            onChange={(iconKey) => onChange({ ...platform, iconKey })}
          />

          <div className="space-y-3 border-t border-border/60 pt-3">
            {platform.apps.map((app, index) => (
              <AppCard
                key={`app-${index}`}
                app={app}
                iconKeys={iconKeys}
                canMoveUp={index > 0}
                canMoveDown={index < platform.apps.length - 1}
                onMove={(delta) => onChange({ ...platform, apps: moveItem(platform.apps, index, delta) })}
                onRemove={() => onChange({ ...platform, apps: removeAt(platform.apps, index) })}
                onDuplicate={() =>
                  onChange({
                    ...platform,
                    apps: [
                      ...platform.apps,
                      { ...app, id: slugify(app.id, takenIds), featured: false },
                    ],
                  })
                }
                onChange={(next) =>
                  onChange({ ...platform, apps: setAppAt(platform.apps, index, next) })
                }
              />
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => onChange({ ...platform, apps: [...platform.apps, emptyApp(takenIds)] })}
            >
              <Plus className="mr-2 h-4 w-4" /> {t('connectPageEditor.addApp')}
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

function AppCard({
  app,
  iconKeys,
  canMoveUp,
  canMoveDown,
  onMove,
  onRemove,
  onDuplicate,
  onChange,
}: {
  app: ConnectApp;
  iconKeys: readonly string[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onChange: (next: ConnectApp) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-border/60">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          <span className="truncate text-sm font-medium">
            {app.name || t('connectPageEditor.unnamedApp')}
          </span>
          {app.featured && <Star className="h-3.5 w-3.5 fill-current text-amber-500" />}
          <Badge variant="outline" className="text-[10px]">
            {t('connectPageEditor.stepCount', { count: app.steps.length })}
          </Badge>
        </button>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={onDuplicate} aria-label={t('connectPageEditor.duplicateApp')}>
            <Copy className="h-4 w-4" />
          </Button>
          <Reorder
            canUp={canMoveUp}
            canDown={canMoveDown}
            onMove={onMove}
            onRemove={onRemove}
            removeLabel={t('connectPageEditor.removeApp')}
          />
        </div>
      </div>

      {open && (
        <div className="space-y-4 border-t border-border/60 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('connectPageEditor.appName')}>
              <Input value={app.name} onChange={(e) => onChange({ ...app, name: e.target.value })} />
            </Field>
            <Field
              label={t('connectPageEditor.appId')}
              hint={t('connectPageEditor.appIdHint')}
            >
              <Input value={app.id} onChange={(e) => onChange({ ...app, id: e.target.value })} />
            </Field>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
            <div className="space-y-0.5">
              <Label className="text-sm">{t('connectPageEditor.featured')}</Label>
              <p className="text-xs text-muted-foreground">{t('connectPageEditor.featuredHint')}</p>
            </div>
            <Switch
              checked={app.featured}
              onCheckedChange={(featured) => onChange({ ...app, featured })}
              aria-label={t('connectPageEditor.featured')}
            />
          </div>

          <IconPicker
            label={t('connectPageEditor.icon')}
            value={app.iconKey ?? null}
            keys={iconKeys}
            onChange={(iconKey) => onChange({ ...app, iconKey })}
          />

          <div className="space-y-3">
            {app.steps.map((step, index) => (
              <StepCard
                key={index}
                step={step}
                index={index}
                iconKeys={iconKeys}
                canMoveUp={index > 0}
                canMoveDown={index < app.steps.length - 1}
                onMove={(delta) => onChange({ ...app, steps: moveItem(app.steps, index, delta) })}
                onRemove={() => onChange({ ...app, steps: removeAt(app.steps, index) })}
                onChange={(next) => onChange({ ...app, steps: replaceAt(app.steps, index, next) })}
              />
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => onChange({ ...app, steps: [...app.steps, emptyStep()] })}
            >
              <Plus className="mr-2 h-4 w-4" /> {t('connectPageEditor.addStep')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Step ─────────────────────────────────────────────────────────────────────

function StepCard({
  step,
  index,
  iconKeys,
  canMoveUp,
  canMoveDown,
  onMove,
  onRemove,
  onChange,
}: {
  step: ConnectStep;
  index: number;
  iconKeys: readonly string[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onChange: (next: ConnectStep) => void;
}): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('connectPageEditor.step', { number: index + 1 })}
        </span>
        <Reorder
          canUp={canMoveUp}
          canDown={canMoveDown}
          onMove={onMove}
          onRemove={onRemove}
          removeLabel={t('connectPageEditor.removeStep')}
        />
      </div>

      <LocalizedField
        label={t('connectPageEditor.stepTitle')}
        value={step.title}
        onChange={(title) => onChange({ ...step, title })}
      />
      <LocalizedField
        label={t('connectPageEditor.stepBody')}
        multiline
        value={step.body ?? { ru: '', en: '' }}
        // Cleared back to `null` rather than left as an empty pair: an empty
        // present value is refused on save, and there was no way to get back
        // to absent through the form.
        onChange={(body) =>
          onChange({
            ...step,
            body: Object.values(body).every((line) => line.trim().length === 0) ? null : body,
          })
        }
      />
      <IconPicker
        label={t('connectPageEditor.icon')}
        value={step.iconKey ?? null}
        keys={iconKeys}
        onChange={(iconKey) => onChange({ ...step, iconKey })}
      />

      <div className="space-y-2">
        {step.buttons.map((button, buttonIndex) => (
          <ButtonRow
            key={buttonIndex}
            button={button}
            canMoveUp={buttonIndex > 0}
            canMoveDown={buttonIndex < step.buttons.length - 1}
            onMove={(delta) => onChange({ ...step, buttons: moveItem(step.buttons, buttonIndex, delta) })}
            onRemove={() => onChange({ ...step, buttons: removeAt(step.buttons, buttonIndex) })}
            onChange={(next) => onChange({ ...step, buttons: replaceAt(step.buttons, buttonIndex, next) })}
          />
        ))}
        <div className="flex flex-wrap gap-2">
          {BUTTON_KINDS.map((kind) => (
            <Button
              key={kind}
              variant="outline"
              size="sm"
              onClick={() => onChange({ ...step, buttons: [...step.buttons, emptyButton(kind)] })}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t(`connectPageEditor.buttonKind.${kind}`)}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Button ───────────────────────────────────────────────────────────────────

function ButtonRow({
  button,
  canMoveUp,
  canMoveDown,
  onMove,
  onRemove,
  onChange,
}: {
  button: ConnectButton;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onChange: (next: ConnectButton) => void;
}): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="secondary">{t(`connectPageEditor.buttonKind.${button.kind}`)}</Badge>
        <Reorder
          canUp={canMoveUp}
          canDown={canMoveDown}
          onMove={onMove}
          onRemove={onRemove}
          removeLabel={t('connectPageEditor.removeButton')}
        />
      </div>

      <LocalizedField
        label={t('connectPageEditor.buttonLabel')}
        value={button.label}
        onChange={(label) => onChange({ ...button, label })}
      />

      {button.kind === 'external' && (
        <Field label={t('connectPageEditor.buttonUrl')} hint={t('connectPageEditor.buttonUrlHint')}>
          <Input
            value={button.url ?? ''}
            placeholder="https://apps.apple.com/app/..."
            onChange={(e) => onChange({ ...button, url: e.target.value })}
          />
        </Field>
      )}

      {button.kind === 'deepLink' && (
        <Field
          label={t('connectPageEditor.buttonTemplate')}
          hint={t('connectPageEditor.buttonTemplateHint', { token: SUBSCRIPTION_LINK_TOKEN })}
        >
          <Input
            value={button.template ?? ''}
            placeholder={`happ://add/${SUBSCRIPTION_LINK_TOKEN}`}
            onChange={(e) => onChange({ ...button, template: e.target.value })}
          />
          {/* Shown, never edited: it is a conclusion the server draws from where
              the placeholder sits, and an editable copy of a conclusion is a
              field that can contradict its own premise. */}
          <p className="pt-1 text-xs text-muted-foreground">
            {t(
              (button.template ?? '').indexOf('?') !== -1 &&
                (button.template ?? '').indexOf('?') <
                  (button.template ?? '').indexOf(SUBSCRIPTION_LINK_TOKEN)
                ? 'connectPageEditor.encodeComponent'
                : 'connectPageEditor.encodeRaw',
            )}
          </p>
        </Field>
      )}

      {button.kind === 'copyLink' && (
        <p className="text-xs text-muted-foreground">{t('connectPageEditor.copyLinkHint')}</p>
      )}
    </div>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────────

function IconLibrary({
  icons,
  sanitized,
  inUse,
  onChange,
}: {
  icons: Record<string, string>;
  /** The icons as the server stored them — the only markup safe to render. */
  sanitized: Record<string, string>;
  inUse: ReadonlySet<string>;
  onChange: (next: Record<string, string>) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [key, setKey] = useState('');
  const [markup, setMarkup] = useState('');

  const add = (): void => {
    if (markup.trim().length === 0 || key.trim().length === 0) return;
    // An existing key REPLACES. Minting `hiddify-2` instead meant an operator
    // could never fix a wrong logo: the new icon was orphaned, the old one
    // could not be deleted because something still pointed at it, and nothing
    // in the interface updated markup.
    const existing = Object.keys(icons).includes(key.trim());
    const slug = existing ? key.trim() : slugify(key, Object.keys(icons));
    onChange({ ...icons, [slug]: markup.trim() });
    setKey('');
    setMarkup('');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('connectPageEditor.icons')}</CardTitle>
        <CardDescription>{t('connectPageEditor.iconsHint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {Object.entries(icons).map(([iconKey, iconMarkup]) => (
            <div
              key={iconKey}
              className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5"
            >
              {/* ONLY server-cleaned markup is rendered. This used to draw the
                  draft, which is the raw paste for anything just added — an
                  `<img onerror>` in the paste box ran in the panel, where the
                  admin token lives in localStorage and the CSP is
                  report-only. A pending icon shows a placeholder until a save
                  has been through the sanitizer. */}
              {sanitized[iconKey] === iconMarkup ? (
                <span
                  aria-hidden="true"
                  className="inline-flex h-5 w-5 [&>svg]:h-5 [&>svg]:w-5"
                  dangerouslySetInnerHTML={{ __html: iconMarkup }}
                />
              ) : (
                <span
                  className="inline-flex h-5 w-5 items-center justify-center rounded border border-dashed border-border text-[9px] text-muted-foreground"
                  title={t('connectPageEditor.iconPending')}
                >
                  ?
                </span>
              )}
              <span className="text-xs">{iconKey}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                disabled={inUse.has(iconKey)}
                title={inUse.has(iconKey) ? t('connectPageEditor.iconInUse') : undefined}
                onClick={() => {
                  const next = { ...icons };
                  delete next[iconKey];
                  onChange(next);
                }}
                aria-label={t('connectPageEditor.removeIcon')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-[200px_1fr_auto] sm:items-end">
          <Field label={t('connectPageEditor.iconKey')}>
            <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="hiddify" />
          </Field>
          <Field label={t('connectPageEditor.iconMarkup')}>
            <Textarea
              rows={2}
              value={markup}
              onChange={(e) => setMarkup(e.target.value)}
              placeholder="<svg viewBox=&quot;0 0 24 24&quot;>…</svg>"
            />
          </Field>
          <Button onClick={add} disabled={markup.trim().length === 0 || key.trim().length === 0}>
            <Plus className="mr-2 h-4 w-4" /> {t('connectPageEditor.addIcon')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function Reorder({
  canUp,
  canDown,
  onMove,
  onRemove,
  removeLabel,
}: {
  canUp: boolean;
  canDown: boolean;
  onMove: (delta: number) => void;
  onRemove: () => void;
  removeLabel: string;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        disabled={!canUp}
        onClick={() => onMove(-1)}
        aria-label={t('connectPageEditor.moveUp')}
      >
        <ChevronUp className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        disabled={!canDown}
        onClick={() => onMove(1)}
        aria-label={t('connectPageEditor.moveDown')}
      >
        <ChevronDown className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" onClick={onRemove} aria-label={removeLabel}>
        <Trash2 className="h-4 w-4 text-destructive" />
      </Button>
    </div>
  );
}

/**
 * Both languages side by side, not behind a modal.
 *
 * The cabinet has two locales, so both fit on one row — and a modal per string
 * is what makes a four-level editor feel like a form-filling exercise. It also
 * makes a half-translated row visible at a glance, which is a state an operator
 * is allowed to save from and ought to be able to see.
 */
function LocalizedField({
  label,
  value,
  multiline = false,
  onChange,
}: {
  label: string;
  value: LocalizedText;
  multiline?: boolean;
  onChange: (next: LocalizedText) => void;
}): JSX.Element {
  const Control = multiline ? Textarea : Input;
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="grid gap-2 sm:grid-cols-2">
        {(['ru', 'en'] as const).map((locale) => (
          <div key={locale} className="relative">
            <Control
              value={value[locale] ?? ''}
              rows={multiline ? 2 : undefined}
              onChange={(e: { target: { value: string } }) =>
                onChange({ ...value, [locale]: e.target.value })
              }
            />
            <span className="pointer-events-none absolute right-2 top-2 text-[10px] uppercase text-muted-foreground">
              {locale}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function IconPicker({
  label,
  value,
  keys,
  onChange,
}: {
  label: string;
  value: string | null;
  keys: readonly string[];
  onChange: (next: string | null) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const NONE = '__none__';
  return (
    <Field label={label}>
      <Select value={value ?? NONE} onValueChange={(next) => onChange(next === NONE ? null : next)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t('connectPageEditor.noIcon')}</SelectItem>
          {keys.map((key) => (
            <SelectItem key={key} value={key}>
              {key}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint !== undefined && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Which icons something still points at.
 *
 * Deleting an icon that a platform or a step references is a save the audit
 * refuses, and finding that out from an error list is worse than not being
 * offered the button.
 */
function collectUsedIcons(config: ConnectPageConfig): Set<string> {
  const used = new Set<string>();
  const add = (key: string | null | undefined): void => {
    if (typeof key === 'string' && key.length > 0) used.add(key);
  };
  for (const platform of config.platforms) {
    add(platform.iconKey);
    for (const app of platform.apps) {
      add(app.iconKey);
      for (const step of app.steps) add(step.iconKey);
    }
  }
  return used;
}
