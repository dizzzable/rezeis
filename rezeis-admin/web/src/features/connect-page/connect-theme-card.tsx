/**
 * connect-theme-card
 * ──────────────────
 * Choosing the appearance of the cabinet's connect screen, and seeing it.
 *
 * ── Why there is a preview at all ────────────────────────────────────────────
 *
 * A concept is a palette, a set of radii and a background, and none of those
 * mean anything read as a list of hex values. The gallery beside this one on the
 * branding page has the same problem and solves it the same way: a phone frame
 * that redraws as you pick. What is different here is that this preview uses the
 * operator's OWN catalog — their platforms, their apps, their step wording — so
 * what they are judging is their screen, not a mock of somebody else's.
 *
 * ── This preview mirrors the cabinet, and mirrors drift ──────────────────────
 *
 * The real screen is `connect-page.tsx` in reiwa. This is a second rendering of
 * the same arrangement, in a different repository, and nothing but care keeps
 * them in step — exactly the situation `branding-preview.tsx` has been in for a
 * year. Two things keep the cost down: the composition is small, and both sides
 * are written against the SAME token names, so a palette that looks right here
 * cannot look different there for reasons of colour. What can drift is layout,
 * and the honest statement is that it will, slowly, unless someone changing one
 * side opens the other.
 *
 * ── "Как в кабинете" is the default and stays reachable ──────────────────────
 *
 * Most installs will never dress this screen separately, and the button that
 * returns to that state is the rollback for the ones that try it and change
 * their minds: no deploy, one click, and the row is deleted rather than left
 * holding an empty theme.
 */
import { useMemo, useState, type CSSProperties, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, Link2, LifeBuoy, Loader2, Palette, Search } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

import { CONCEPT_THEME_PRESETS } from '../branding/theme-presets';
import { buildConnectScreenTheme } from './connect-screen-theme';
import {
  CONNECT_PAGE_KEYS,
  connectPageApi,
  type ConnectPageConfig,
  type ConnectTheme,
} from './connect-page-api';

export function ConnectThemeCard({
  config,
  sanitized,
  theme,
  canEdit,
}: {
  readonly config: ConnectPageConfig;
  /**
   * Icon markup the SERVER has returned, which is the only markup this card is
   * allowed to inject.
   *
   * `config` is the editor's DRAFT — `draft ?? data.config` — so its `icons` may
   * hold a string an operator pasted thirty seconds ago and has not saved. The
   * sanitizer runs on the server, on save. Rendering the draft here would put
   * unsanitized SVG into the panel's own DOM, where the admin token lives in
   * `localStorage` and the CSP is report-only in production. That is not a
   * hypothetical: it is the defect the icon library beside this card was fixed
   * for, and this card reintroduced it.
   *
   * An unsaved icon therefore previews as its letter, exactly as an app with no
   * icon does in the cabinet.
   */
  readonly sanitized: Record<string, string>;
  readonly theme: ConnectTheme | null;
  readonly canEdit: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');

  /**
   * What the preview paints, in three states rather than two.
   *
   * `undefined` — nothing picked in this session, so the stored choice shows.
   * `null`      — "the cabinet's own" was picked, which is a CHOICE and has to
   *               be distinguishable from not having chosen: it is what clears
   *               a stored concept.
   * a string    — that concept was picked.
   *
   * The two-state version collapsed the middle one into "nothing picked", so
   * the option that clears a theme could never be dirty and its Apply button
   * could never appear.
   *
   * Local state rather than optimistic cache writes: a preview is a question,
   * and a question should not look like an answer until it is saved.
   */
  const [pending, setPending] = useState<string | null | undefined>(undefined);
  const stored = theme?.presetId ?? null;
  const selectedId = pending === undefined ? stored : pending;

  const previewTheme = useMemo(() => {
    if (selectedId === null) return null;
    return buildConnectScreenTheme(selectedId) ?? null;
  }, [selectedId]);

  const presets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return CONCEPT_THEME_PRESETS;
    return CONCEPT_THEME_PRESETS.filter(
      (preset) =>
        preset.name.toLowerCase().includes(needle) ||
        preset.code.toLowerCase().includes(needle) ||
        preset.visualFamily.toLowerCase().includes(needle),
    );
  }, [query]);

  const save = useMutation({
    mutationFn: (presetId: string | null) =>
      connectPageApi.setTheme(presetId === null ? null : buildConnectScreenTheme(presetId)),
    onSuccess: async (result) => {
      setPending(undefined);
      toast.success(
        result.theme === null
          ? t('connectPageEditor.theme.clearedToast')
          : t('connectPageEditor.theme.savedToast'),
      );
      await queryClient.invalidateQueries({ queryKey: CONNECT_PAGE_KEYS.all });
    },
    onError: () => toast.error(t('connectPageEditor.theme.saveFailed')),
  });

  const dirty = pending !== undefined && pending !== stored;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Palette className="h-4 w-4" aria-hidden="true" />
          {t('connectPageEditor.theme.title')}
        </CardTitle>
        <CardDescription>{t('connectPageEditor.theme.description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('connectPageEditor.theme.search')}
              className="pl-8"
              aria-label={t('connectPageEditor.theme.search')}
            />
          </div>

          <div
            role="listbox"
            aria-label={t('connectPageEditor.theme.title')}
            data-testid="connect-theme-gallery"
            className="grid max-h-[26rem] grid-cols-2 gap-2 overflow-y-auto pr-1 xl:grid-cols-3"
          >
            {/* The cabinet's own appearance is an OPTION, not a reset button
                beside the options. It is what most installs run and what every
                install starts on, so it belongs in the same row, chosen with
                the same gesture and showing the same selected state. As a
                separate button it read as "undo", which is a different promise:
                undo puts back what was there, this picks a look. */}
            <button
              type="button"
              role="option"
              aria-selected={selectedId === null}
              data-testid="connect-theme-inherit"
              disabled={!canEdit}
              onClick={() => setPending(null)}
              className={`rounded-lg border p-2 text-left transition ${
                selectedId === null
                  ? 'border-primary ring-1 ring-primary'
                  : 'border-border hover:bg-muted/50'
              }`}
            >
              {/* No swatch of its own on purpose: from this screen the cabinet's
                  palette is whatever the branding page currently says, and
                  painting a guess at it here would be a second answer to a
                  question that already has one. */}
              <span className="flex h-6 items-center justify-center rounded border border-dashed border-border text-[10px] text-muted-foreground">
                {t('connectPageEditor.theme.inheritSwatch')}
              </span>
              <span className="mt-1.5 flex items-center gap-1">
                {selectedId === null && (
                  <Check className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
                )}
                <span className="truncate text-xs font-medium">
                  {t('connectPageEditor.theme.inherit')}
                </span>
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {t('connectPageEditor.theme.inheritHint')}
              </span>
            </button>

            {presets.map((preset) => {
              const active = preset.id === selectedId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={!canEdit}
                  onClick={() => setPending(preset.id)}
                  className={`rounded-lg border p-2 text-left transition ${
                    active ? 'border-primary ring-1 ring-primary' : 'border-border hover:bg-muted/50'
                  }`}
                >
                  <span className="flex h-6 overflow-hidden rounded">
                    {preset.palette.slice(0, 6).map((colour, index) => (
                      <span
                        key={`${preset.id}-${index}`}
                        className="flex-1"
                        style={{ background: colour }}
                      />
                    ))}
                  </span>
                  <span className="mt-1.5 flex items-center gap-1">
                    {active && <Check className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />}
                    <span className="truncate text-xs font-medium">{preset.name}</span>
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {preset.code} · {preset.visualFamily}
                  </span>
                </button>
              );
            })}
            {presets.length === 0 && (
              <p className="col-span-full py-6 text-center text-sm text-muted-foreground">
                {t('connectPageEditor.theme.noMatches')}
              </p>
            )}
          </div>

          {dirty && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!canEdit || save.isPending || pending === undefined}
                onClick={() => pending !== undefined && save.mutate(pending)}
              >
                {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}
                {t('connectPageEditor.theme.apply')}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPending(undefined)}>
                {t('common.cancel')}
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            {t('connectPageEditor.theme.previewLabel')}
          </p>
          <ConnectScreenPreview config={config} sanitized={sanitized} theme={previewTheme} />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The markup for one icon, or `undefined` when it is not safe to inject.
 *
 * Safe means: the draft's markup for this key is byte-identical to what the
 * server last returned for it. Anything else — a new icon, an edited one, a key
 * the server has never seen — is a string that has not been through the
 * sanitizer, and this component renders into the panel's own DOM.
 *
 * Same test the icon library two cards down already applies, deliberately
 * spelled the same way: `sanitized[key] === draft[key]`.
 */
function safeIcon(
  config: ConnectPageConfig,
  sanitized: Record<string, string>,
  key: string | null | undefined,
): string | undefined {
  if (!key) return undefined;
  const draft = config.icons[key];
  return draft !== undefined && sanitized[key] === draft ? draft : undefined;
}

/**
 * An icon from the operator's own library.
 *
 * `tinted` marks the ones drawn on `currentColor` — platform and step glyphs,
 * which take the concept accent. Application marks are not tinted and sit on a
 * dark plate, because most of them are a light glyph with no ground of their
 * own; that plate is the one thing on this screen that does not follow the
 * concept, and the cabinet draws it the same way for the same reason.
 */
function Mark({
  markup,
  className,
  tinted,
  letter,
}: {
  readonly markup?: string;
  readonly className: string;
  readonly tinted?: boolean;
  readonly letter?: string;
}): JSX.Element {
  const glyph =
    typeof markup === 'string' && markup.startsWith('<svg') ? (
      <span
        className={`${className} [&>svg]:h-full [&>svg]:w-full`}
        dangerouslySetInnerHTML={{ __html: markup }}
      />
    ) : (
      <span className={`${className} text-[8px] font-bold leading-none`}>{letter ?? ''}</span>
    );

  if (tinted) {
    return (
      <span className="inline-flex shrink-0 items-center" style={{ color: 'var(--brand-primary)' }}>
        {glyph}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[3px] border border-white/15 bg-black/80 p-[1px] text-white/70">
      {glyph}
    </span>
  );
}

/** Values the preview paints with; `null` means "whatever the cabinet wears". */
interface PreviewTheme {
  readonly tokens: Readonly<Record<string, string>>;
  readonly backgroundColor: string;
  readonly backgroundImage: string;
  readonly rail: string;
}

/**
 * The cabinet's connect screen, at a glance.
 *
 * Deliberately NOT a pixel copy. It is the arrangement — the header over a
 * hairline, the 2×2 facts, one workspace holding the picker, an app grid and a
 * single divided timeline — because that arrangement is what a concept has to
 * survive, and a copy accurate to the pixel would only be a copy that goes
 * stale faster.
 */
function ConnectScreenPreview({
  config,
  sanitized,
  theme,
}: {
  readonly config: ConnectPageConfig;
  readonly sanitized: Record<string, string>;
  readonly theme: PreviewTheme | null;
}): JSX.Element {
  const { t } = useTranslation();
  const platform = config.platforms[0] ?? null;
  const app = platform?.apps.find((candidate) => candidate.featured) ?? platform?.apps[0] ?? null;
  const apps = (platform?.apps ?? []).slice(0, 4);
  const steps = (app?.steps ?? []).slice(0, 4);

  const style: CSSProperties = theme === null
    ? {}
    : ({
        ...Object.fromEntries(
          Object.entries(theme.tokens).map(([token, value]) => [`--${token}`, value]),
        ),
        backgroundColor: theme.backgroundColor,
        backgroundImage: theme.backgroundImage,
      } as CSSProperties);

  // The fallbacks are the cabinet's OWN built-in values, not the panel's. The
  // preview has to answer "what does this look like with no concept" and the
  // panel's own surface colours would answer a different question.
  const fallback: CSSProperties = {
    // The cabinet's literal built-in values, NOT `var(--primary)`. Those
    // resolve against the PANEL's root, where the accent is a near-black or
    // near-white monochrome — so "как в кабинете", the default state most
    // installs run, previewed the admin panel's accent as the customer's brand
    // colour. The other six below were already the cabinet's own numbers.
    ['--brand-primary' as string]: '#22c55e',
    ['--brand-primary-fg' as string]: '#0a0a0a',
    ['--brand-foreground' as string]: '#fafafa',
    ['--brand-muted-foreground' as string]: '#a1a1a1',
    ['--color-surface' as string]: 'rgba(24,24,27,0.7)',
    ['--color-surface-high' as string]: 'rgba(39,39,42,0.8)',
    ['--color-border-soft' as string]: 'rgba(255,255,255,0.06)',
    ['--radius-card' as string]: '22px',
    ['--radius-item' as string]: '14px',
    backgroundColor: '#09090b',
  };

  const raised =
    'rounded-[var(--radius-card)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface-high)]';
  const sunken = 'border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)]';

  return (
    <div
      data-testid="connect-theme-preview"
      className="relative overflow-hidden rounded-2xl border border-border"
      style={{ ...fallback, ...style, color: 'var(--brand-foreground)' }}
    >
      {theme !== null && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-1"
          style={{ background: theme.rail }}
        />
      )}

      <div className="relative space-y-3 px-4 py-4 text-[11px]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="h-6 w-6 shrink-0 rounded-[8px]"
              style={{ background: 'var(--brand-primary)' }}
            />
            <span className="truncate text-sm font-bold tracking-wide">
              {t('connectPageEditor.theme.previewBrand')}
            </span>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <span
              className={`${sunken} flex h-6 w-6 items-center justify-center rounded-full`}
              style={{ color: 'var(--brand-primary)' }}
            >
              <Link2 className="h-3 w-3" aria-hidden="true" />
            </span>
            <span
              className={`${sunken} flex h-6 w-6 items-center justify-center rounded-full`}
              style={{ color: 'var(--brand-primary)' }}
            >
              <LifeBuoy className="h-3 w-3" aria-hidden="true" />
            </span>
          </div>
        </div>

        <div className="h-px" style={{ background: 'var(--color-border-soft)' }} />

        <div className="grid grid-cols-2 gap-1.5">
          {[
            [t('connectPageEditor.theme.factName'), 'dizzable'],
            [t('connectPageEditor.theme.factStatus'), t('connectPageEditor.theme.factActive')],
            [t('connectPageEditor.theme.factExpires'), '28.02.2100'],
            [t('connectPageEditor.theme.factTraffic'), '351 / ∞'],
          ].map(([label, value]) => (
            <div key={label} className={`${raised} p-2`}>
              <p
                className="text-[8px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--brand-muted-foreground)' }}
              >
                {label}
              </p>
              <p className="mt-1 truncate text-[11px] font-semibold">{value}</p>
            </div>
          ))}
        </div>

        <div className={`${raised} space-y-2.5 p-3`}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold">{t('connectPageEditor.theme.install')}</p>
            <span className={`${sunken} flex items-center gap-1.5 rounded-full px-2 py-1 text-[10px]`}>
              <Mark markup={safeIcon(config, sanitized, platform?.iconKey)} className="h-3 w-3" tinted />
              {platform === null ? '—' : (platform.title.ru ?? platform.title.en ?? platform.id)}
            </span>
          </div>

          {apps.length > 0 && (
            <div className="grid grid-cols-2 gap-1.5">
              {apps.map((candidate) => {
                const active = candidate.id === app?.id;
                return (
                  <span
                    key={candidate.id}
                    className={
                      active
                        ? 'flex items-center gap-1.5 rounded-full px-2 py-1.5 text-[10px] font-semibold'
                        : `${sunken} flex items-center gap-1.5 rounded-full px-2 py-1.5 text-[10px]`
                    }
                    style={
                      active
                        ? {
                            background: 'var(--brand-primary)',
                            color: 'var(--brand-primary-fg)',
                          }
                        : { color: 'var(--brand-muted-foreground)' }
                    }
                  >
                    <Mark
                      markup={safeIcon(config, sanitized, candidate.iconKey)}
                      className="h-3.5 w-3.5"
                      letter={candidate.name.slice(0, 1)}
                    />
                    <span className="truncate">{candidate.name}</span>
                    {candidate.featured && (
                      <span
                        className="ml-auto h-[4px] w-[4px] shrink-0 rounded-full"
                        style={{
                          background: active
                            ? 'var(--brand-primary-fg)'
                            : 'var(--brand-primary)',
                        }}
                      />
                    )}
                  </span>
                );
              })}
            </div>
          )}

          {steps.length > 0 && (
            <div className={`${sunken} rounded-[var(--radius-card)] px-2.5`}>
              {steps.map((step, index) => (
                <div key={`${step.title.ru ?? index}`}>
                  {index > 0 && <div className="h-px" style={{ background: 'var(--color-border-soft)' }} />}
                  <div className="flex gap-2 py-2.5">
                    <span
                      className={`${sunken} flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[8px] font-bold`}
                      style={{ color: 'var(--brand-primary)' }}
                    >
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-semibold">
                        {step.title.ru ?? step.title.en ?? ''}
                      </p>
                      {step.body != null && (
                        <p
                          className="line-clamp-2 text-[10px]"
                          style={{ color: 'var(--brand-muted-foreground)' }}
                        >
                          {step.body.ru ?? step.body.en ?? ''}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {steps.length === 0 && (
            <p className="text-[10px]" style={{ color: 'var(--brand-muted-foreground)' }}>
              {t('connectPageEditor.theme.previewEmpty')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
