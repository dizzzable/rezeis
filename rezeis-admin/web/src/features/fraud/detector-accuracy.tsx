/**
 * Detector accuracy — how often each detector was wrong, per its own operators.
 *
 * WHY IT IS HERE AND NOT IN SETTINGS → ANTI-FRAUD.
 * ───────────────────────────────────────────────
 * The thresholds this report informs are edited in the settings tab, so that
 * was the other candidate. Three things put it on the fraud page instead:
 *
 *   1. RBAC. The endpoint behind it is gated on `fraud_signals:view`, matching
 *      every other read on `AdminFraudController`. This whole page is gated on
 *      the same permission; the settings tab is gated on `settings:view`. A
 *      card in the settings tab would therefore either 403 for a
 *      settings-only operator or be hidden from them — an unexplained hole in
 *      a form — while a fraud analyst without `settings:view` could not reach
 *      it at all. Here, everyone who can see the page can see the report.
 *   2. The data is this page's own output. The "Dismiss — false positive"
 *      control that produces every number in the table is in the row actions a
 *      few hundred pixels below. The feedback loop closes where it is created,
 *      and an operator can go straight from "this code is 60% false positives"
 *      to the signals that made it so.
 *   3. It is a report, and this page is where the reports are — counters,
 *      trend, top offenders, held candidates. The settings tab is a form.
 *
 * The tuning operator is not left to find it: the anti-fraud settings tab
 * carries a link here, gated on the same `fraud_signals:view` so it only
 * appears to somebody who can actually follow it.
 *
 * STRICTLY READ-ONLY. There is no mutation in this file and none behind the
 * endpoint — the service issues `groupBy` and nothing else. Looking at your own
 * dismissal rate must not be an action on any signal.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Gauge } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { getDetectorAccuracy, type DetectorAccuracyRow } from './fraud-api';

const WINDOW_OPTIONS = [7, 30, 90] as const;

/**
 * Where a dismissal rate stops being a curiosity and starts being a reason to
 * change a threshold. Presentation only — the server decides whether a rate is
 * shown at all, and nothing here feeds back into detection.
 */
const RATE_CONCERNING = 50;
const RATE_NOTABLE = 25;

function rateVariant(rate: number): 'destructive' | 'warning' | 'secondary' {
  if (rate >= RATE_CONCERNING) return 'destructive';
  if (rate >= RATE_NOTABLE) return 'warning';
  return 'secondary';
}

export function DetectorAccuracyPanel() {
  const { t } = useTranslation();
  const [days, setDays] = useState<number>(30);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'fraud', 'detector-accuracy', days],
    queryFn: () => getDetectorAccuracy(days),
  });

  return (
    // Its own provider, like `fraud-version-info.tsx` and the dashboard health
    // card: this panel has to render correctly wherever it is mounted and in a
    // test harness that wires only the query client and i18n.
    <TooltipProvider delayDuration={200}>
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gauge className="h-4 w-4" />
              {t('fraudPage.accuracy.title')}
            </CardTitle>
            <CardDescription>{t('fraudPage.accuracy.subtitle')}</CardDescription>
          </div>
          <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOW_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {t('fraudPage.accuracy.window', { count: option })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, idx) => (
              <Skeleton key={idx} className="h-9 w-full" />
            ))}
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{t('fraudPage.errors.title')}</AlertTitle>
            <AlertDescription>{t('fraudPage.accuracy.loadFailed')}</AlertDescription>
          </Alert>
        ) : !data || data.rows.length === 0 ? (
          // An empty window is a real answer, not a failure: no detector raised
          // anything in the period. Said in words rather than shown as an empty
          // table, which reads as a broken page.
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('fraudPage.accuracy.empty', { count: data?.windowDays ?? days })}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('fraudPage.accuracy.columns.code')}</TableHead>
                    <TableHead className="w-20 text-right">
                      {t('fraudPage.accuracy.columns.opened')}
                    </TableHead>
                    <TableHead className="w-20 text-right">
                      {t('fraudPage.accuracy.columns.stillOpen')}
                    </TableHead>
                    <TableHead className="w-24 text-right">
                      {t('fraudPage.accuracy.columns.resolved')}
                    </TableHead>
                    <TableHead className="w-24 text-right">
                      {t('fraudPage.accuracy.columns.dismissed')}
                    </TableHead>
                    <TableHead className="w-32 text-right">
                      {t('fraudPage.accuracy.columns.falsePositiveRate')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((row) => (
                    <AccuracyRow
                      key={row.code}
                      row={row}
                      minAdjudicated={data.minAdjudicatedForRate}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {t('fraudPage.accuracy.footnote', { count: data.minAdjudicatedForRate })}
            </p>
          </>
        )}
      </CardContent>
    </Card>
    </TooltipProvider>
  );
}

function AccuracyRow({
  row,
  minAdjudicated,
}: {
  row: DetectorAccuracyRow;
  minAdjudicated: number;
}) {
  const { t } = useTranslation();
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{row.code}</TableCell>
      <TableCell className="text-right tabular-nums">{row.total}</TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {row.open + row.acknowledged}
      </TableCell>
      {/* The split matters: only the operator half of `resolved` is a verdict,
          and the system half is what a naive rate would silently swallow. */}
      <TableCell className="text-right tabular-nums">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help border-b border-dotted border-muted-foreground/50">
              {row.operatorResolved}
              <span className="text-muted-foreground"> (+{row.autoResolved})</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>{t('fraudPage.accuracy.resolvedHint')}</TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-right tabular-nums">{row.dismissed}</TableCell>
      <TableCell className="text-right">
        {row.falsePositiveRate === null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help text-xs text-muted-foreground">
                {t('fraudPage.accuracy.notEnoughData')}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t('fraudPage.accuracy.notEnoughDataHint', {
                adjudicated: row.adjudicated,
                required: minAdjudicated,
              })}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant={rateVariant(row.falsePositiveRate)} className="tabular-nums">
                {row.falsePositiveRate}%
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {t('fraudPage.accuracy.rateHint', {
                dismissed: row.dismissed,
                adjudicated: row.adjudicated,
              })}
            </TooltipContent>
          </Tooltip>
        )}
      </TableCell>
    </TableRow>
  );
}
