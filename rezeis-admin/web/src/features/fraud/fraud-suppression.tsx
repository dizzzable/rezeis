/**
 * What the detectors saw and did NOT report, and the standing decisions that
 * keep it that way.
 *
 * This panel exists because the two gates in front of `upsertSignal` are both
 * forms of silence, and silence is the one detector state an operator cannot
 * notice on their own. A condition gathering evidence looks identical to no
 * condition at all; a user under an exemption looks identical to a user nobody
 * suspects. Both are rendered here, with the reason attached.
 */
import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EyeOff,
  Gavel,
  Hourglass,
  Loader2,
  Plus,
  ShieldCheck,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime } from '@/lib/utils';
import {
  FRAUD_DETECTOR_CODES,
  createFraudExemption,
  getPendingFraudCandidates,
  listFraudExemptions,
  revokeFraudExemption,
  type CandidateHold,
  type FraudExemption,
  type PendingFraudCandidate,
} from './fraud-api';

const PENDING_KEY = ['admin', 'fraud', 'pending'] as const;
const EXEMPTIONS_KEY = ['admin', 'fraud', 'exemptions'] as const;

export function FraudSuppressionPanel() {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <HeldCandidatesCard />
      <ExemptionsCard />
    </div>
  );
}

// ── Held candidates ───────────────────────────────────────────────────────

interface HoldPresentation {
  readonly variant: ComponentProps<typeof Badge>['variant'];
  readonly Icon: LucideIcon;
  readonly labelKey: string;
  /** A sentence under the badge, where the badge alone would understate it. */
  readonly hintKey: string | null;
}

/**
 * One entry per member of `CandidateHold`, and a `Record` on purpose.
 *
 * What stood here was a BINARY ternary — `exemption ? … : streak` — so the
 * third kind fell into the else branch and every verdict-muted condition wore
 * the streak badge. With `observations` clamped to `requiredObservations` by
 * the server, that badge read "Seen 3/3 runs": the operator was told evidence
 * was complete and a signal was imminent, when in fact their own dismissal was
 * holding the detector shut. A ternary cannot be exhaustive; this map is, and
 * a fourth kind added to the union fails the compile right here instead of
 * quietly inheriting someone else's badge.
 */
const HOLD_PRESENTATION: Record<CandidateHold, HoldPresentation> = {
  streak: {
    variant: 'outline',
    Icon: Hourglass,
    labelKey: 'fraudPage.suppression.held.byStreak',
    hintKey: null,
  },
  exemption: {
    variant: 'secondary',
    Icon: EyeOff,
    labelKey: 'fraudPage.suppression.held.byExemption',
    hintKey: null,
  },
  verdict: {
    variant: 'warning',
    Icon: Gavel,
    labelKey: 'fraudPage.suppression.held.byVerdict',
    // Named, because this is the one hold an operator can create by accident:
    // a bulk dismissal mutes the condition for a week and the only other trace
    // is a log line.
    hintKey: 'fraudPage.suppression.held.byVerdictHint',
  },
};

/**
 * Why this row was not filed.
 *
 * The streak counters are passed for every kind and read by only one of them —
 * `byStreak` is the sole key that interpolates them, because "seen N of M" is
 * only true while evidence is what is missing. Under an exemption or a verdict
 * the count keeps rising against a bar that is no longer the thing in the way,
 * so printing it would answer a question nobody asked with a number that
 * implies the opposite of the truth.
 */
function HoldReason({ item }: { readonly item: PendingFraudCandidate }) {
  const { t } = useTranslation();
  const hold = HOLD_PRESENTATION[item.heldBy];
  const HoldIcon = hold.Icon;

  return (
    <div className="space-y-1">
      <Badge variant={hold.variant} className="gap-1 text-[11px]">
        <HoldIcon className="h-3 w-3" />
        {String(
          t(hold.labelKey, {
            seen: item.observations,
            required: item.requiredObservations,
          }),
        )}
      </Badge>
      {hold.hintKey !== null && (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {String(t(hold.hintKey))}
        </p>
      )}
    </div>
  );
}

function HeldCandidatesCard() {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useQuery({
    queryKey: PENDING_KEY,
    queryFn: () => getPendingFraudCandidates(50),
  });
  const items = data ?? [];

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Hourglass className="h-4 w-4" />
          {t('fraudPage.suppression.held.title')}
        </CardTitle>
        <CardDescription>{t('fraudPage.suppression.held.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, idx) => (
              <Skeleton key={idx} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          // NOT the empty state, and the distinction is the whole card: this
          // panel's only job is to say what is being suppressed, so a failed
          // load rendering "nothing is being held back" would be the exact
          // false reassurance it exists to prevent.
          <p className="py-8 text-center text-sm text-destructive">
            {t('fraudPage.suppression.held.loadFailed')}
          </p>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('fraudPage.suppression.held.empty')}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('fraudPage.suppression.held.columns.signal')}</TableHead>
                <TableHead className="w-40">
                  {t('fraudPage.suppression.held.columns.reason')}
                </TableHead>
                <TableHead className="w-32">
                  {t('fraudPage.suppression.held.columns.lastSeen')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <p className="text-sm font-medium leading-tight">{item.title}</p>
                    <p className="text-[11px] text-muted-foreground font-mono">{item.code}</p>
                  </TableCell>
                  <TableCell>
                    <HoldReason item={item} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDateTime(item.lastSeenAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ── Exemptions ────────────────────────────────────────────────────────────

function ExemptionsCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: EXEMPTIONS_KEY,
    queryFn: () => listFraudExemptions(),
  });
  const items = data ?? [];

  const revokeMutation = useMutation({
    mutationFn: revokeFraudExemption,
    onSuccess: () => {
      toast.success(t('fraudPage.suppression.exemptions.revoked'));
      queryClient.invalidateQueries({ queryKey: ['admin', 'fraud'] });
    },
    onError: (err) =>
      toast.error(
        t('fraudPage.suppression.exemptions.revokeFailed', { message: (err as Error).message }),
      ),
  });

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              {t('fraudPage.suppression.exemptions.title')}
            </CardTitle>
            <CardDescription>
              {t('fraudPage.suppression.exemptions.subtitle')}
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            {t('fraudPage.suppression.exemptions.add')}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, idx) => (
              <Skeleton key={idx} className="h-10 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('fraudPage.suppression.exemptions.empty')}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('fraudPage.suppression.exemptions.columns.user')}</TableHead>
                <TableHead>{t('fraudPage.suppression.exemptions.columns.codes')}</TableHead>
                <TableHead className="w-32">
                  {t('fraudPage.suppression.exemptions.columns.expires')}
                </TableHead>
                <TableHead className="w-20 text-right">
                  {t('fraudPage.suppression.exemptions.columns.actions')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <ExemptionRow
                  key={item.id}
                  exemption={item}
                  disabled={revokeMutation.isPending}
                  onRevoke={() => revokeMutation.mutate(item.id)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <CreateExemptionDialog open={creating} onClose={() => setCreating(false)} />
    </Card>
  );
}

function ExemptionRow({
  exemption,
  disabled,
  onRevoke,
}: {
  exemption: FraudExemption;
  disabled: boolean;
  onRevoke: () => void;
}) {
  const { t } = useTranslation();
  return (
    <TableRow className={exemption.active ? undefined : 'opacity-60'}>
      <TableCell>
        <p className="font-mono text-xs">{exemption.userId}</p>
        <p className="text-[11px] text-muted-foreground">{exemption.reason}</p>
        {exemption.createdByLogin && (
          <p className="text-[11px] text-muted-foreground">
            {t('fraudPage.suppression.exemptions.grantedBy', { login: exemption.createdByLogin })}
          </p>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {exemption.codes.map((code) => (
            <Badge key={code} variant="outline" className="text-[10px] font-mono">
              {code}
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell className="text-xs">
        {formatDateTime(exemption.expiresAt)}
        {!exemption.active && (
          <Badge variant="secondary" className="ml-1 text-[10px]">
            {exemption.revokedAt
              ? t('fraudPage.suppression.exemptions.statusRevoked')
              : t('fraudPage.suppression.exemptions.statusExpired')}
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        {exemption.active && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-xs"
            disabled={disabled}
            onClick={onRevoke}
          >
            <Undo2 className="h-3 w-3" />
            {t('fraudPage.suppression.exemptions.revoke')}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

/** Tomorrow, as `yyyy-mm-dd` — the earliest expiry the form will accept. */
function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function CreateExemptionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [reason, setReason] = useState('');

  function reset(): void {
    setUserId('');
    setCodes([]);
    setExpiresAt('');
    setReason('');
  }

  const mutation = useMutation({
    mutationFn: createFraudExemption,
    onSuccess: () => {
      toast.success(t('fraudPage.suppression.exemptions.created'));
      queryClient.invalidateQueries({ queryKey: ['admin', 'fraud'] });
      reset();
      onClose();
    },
    onError: (err) =>
      toast.error(
        t('fraudPage.suppression.exemptions.createFailed', { message: (err as Error).message }),
      ),
  });

  // Every one of these is required by the API too. The form mirrors the rule
  // rather than owning it — an expiry is mandatory because a permanent
  // exemption is a permanent blind spot, and the column is NOT NULL to match.
  const valid =
    userId.trim().length > 0 &&
    codes.length > 0 &&
    reason.trim().length >= 3 &&
    expiresAt.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('fraudPage.suppression.exemptions.dialog.title')}</DialogTitle>
          <DialogDescription>
            {t('fraudPage.suppression.exemptions.dialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="exemption-user">
              {t('fraudPage.suppression.exemptions.dialog.userLabel')}
            </Label>
            <Input
              id="exemption-user"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder={t('fraudPage.suppression.exemptions.dialog.userPlaceholder')}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('fraudPage.suppression.exemptions.dialog.codesLabel')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('fraudPage.suppression.exemptions.dialog.codesHint')}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 pt-1">
              {FRAUD_DETECTOR_CODES.map((code) => (
                <label key={code} className="flex items-center gap-2 text-xs font-mono">
                  <Checkbox
                    checked={codes.includes(code)}
                    onCheckedChange={() =>
                      setCodes((prev) =>
                        prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
                      )
                    }
                    aria-label={code}
                  />
                  {code}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="exemption-expires">
              {t('fraudPage.suppression.exemptions.dialog.expiresLabel')}
            </Label>
            <Input
              id="exemption-expires"
              type="date"
              min={tomorrow()}
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('fraudPage.suppression.exemptions.dialog.expiresHint')}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="exemption-reason">
              {t('fraudPage.suppression.exemptions.dialog.reasonLabel')}
            </Label>
            <Textarea
              id="exemption-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('fraudPage.suppression.exemptions.dialog.reasonPlaceholder')}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('fraudPage.suppression.exemptions.dialog.cancel')}
          </Button>
          <Button
            disabled={!valid || mutation.isPending}
            onClick={() =>
              mutation.mutate({
                userId: userId.trim(),
                codes,
                reason: reason.trim(),
                // The API takes an ISO instant; the picker gives a date. End of
                // the chosen day is the reading an operator expects from
                // "until the 30th".
                expiresAt: new Date(`${expiresAt}T23:59:59.999Z`).toISOString(),
              })
            }
          >
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('fraudPage.suppression.exemptions.dialog.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
