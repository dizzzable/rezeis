/**
 * subpage-import-card
 * ───────────────────
 * "I already built this catalog on the external page — read it instead."
 *
 * ── Why the import does not save ─────────────────────────────────────────────
 *
 * It replaces the DRAFT and stops. The operator then reads the report, looks at
 * what landed in the editor below, and presses Save themselves. Writing straight
 * to the database would mean one mis-picked file replaces a working catalog with
 * no way back — and the file is chosen from a disk we cannot see.
 *
 * ── Why the report is not a toast ────────────────────────────────────────────
 *
 * A conversion that quietly loses two platforms is worse than one that refuses:
 * the operator saves, the screen is short, and nothing says why. Every decision
 * the converter made is listed here and stays on screen until the next import.
 */
import { useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { importExternalSubpage, type ImportReport } from './subpage-import';
import type { ConnectPageConfig } from './connect-page-api';

/** A file bigger than this is not a subscription-page export. */
const MAX_BYTES = 4 * 1024 * 1024;

export function SubpageImportCard({
  canEdit,
  existingIcons,
  onImported,
}: {
  readonly canEdit: boolean;
  /**
   * The library already in the editor. An export holds the SAME drawings under
   * the donor's own names — `ClashMeta` there, `clash-meta` here — so without
   * this the import doubles the library and the operator cannot tell which of
   * two identical logos their catalog points at.
   */
  readonly existingIcons: Readonly<Record<string, string>>;
  readonly onImported: (config: ConnectPageConfig) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function read(file: File): Promise<void> {
    setReport(null);
    setError(null);
    if (file.size > MAX_BYTES) {
      setError(t('connectPageEditor.import.tooLarge'));
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const { config, report: produced } = importExternalSubpage(parsed, { existingIcons });
      // The switch and the appearance live in their own rows and are stamped on
      // every read, so the imported draft carries neither — it is a catalog.
      onImported(config as unknown as ConnectPageConfig);
      setReport(produced);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('connectPageEditor.import.unreadable'));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Upload className="h-4 w-4" aria-hidden="true" />
          {t('connectPageEditor.import.title')}
        </CardTitle>
        <CardDescription>{t('connectPageEditor.import.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so choosing the SAME file twice fires again — after a
            // failed import that is exactly what an operator does.
            event.target.value = '';
            if (file !== undefined) void read(file);
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canEdit}
            onClick={() => input.current?.click()}
          >
            {t('connectPageEditor.import.choose')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t('connectPageEditor.import.hint')}
          </span>
        </div>

        {error !== null && (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}

        {report !== null && (
          <div data-testid="connect-import-report" className="space-y-2">
            <p className="text-sm font-medium">
              {t('connectPageEditor.import.done', {
                platforms: report.platforms,
                apps: report.apps,
                steps: report.steps,
                icons: report.icons,
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('connectPageEditor.import.reviewHint')}
            </p>
            {report.notes.length > 0 && (
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border/60 p-2">
                {report.notes.map((note, index) => (
                  <li key={index} className="text-xs text-muted-foreground">
                    {note}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
