/**
 * The switch that moves "Подключить" inside the cabinet.
 *
 * A card of its own rather than a field in the editor below it, because it is
 * not part of the catalog an operator edits — it is the decision about whether
 * anybody sees that catalog at all, and it stays usable while the catalog is
 * half-written.
 *
 * It reads and writes the v2 config directly. The editor beside it is still
 * bound to v1 and the two are stored under separate keys, so neither can save
 * over the other.
 *
 * ── One key, one reader ───────────────────────────────────────────
 *
 * This card used to declare its own `['admin','connect-page']` with its own
 * shallow schema, and both it and the editor are always mounted. React Query
 * keys ARE the cache entry: two observers on one key share the row, and the
 * fetch runs whichever `queryFn` the winning observer had. When this card's won,
 * its schema dropped `corrupted` on the floor — and `corrupted` is the flag that
 * says "the row in the database cannot be read, what you see below is the
 * built-in default, saving over it destroys your real catalog". The editor's red
 * banner went dark, silently, decided by mount order.
 *
 * So the key and the reader come from the editor's module now. This card wants
 * one boolean out of that answer; it does not want a second opinion about the
 * shape of it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';

import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { CONNECT_PAGE_KEYS, connectPageApi } from '@/features/connect-page/connect-page-api';
import { usePermissionStore } from '@/features/rbac/use-permission-store';

/**
 * Writes the switch and NOTHING else.
 *
 * It used to PUT the whole config back with one boolean changed, which meant
 * the first flick froze the built-in default catalog into the database
 * forever — no later improvement to it would ever reach this install — and a
 * catalog draft branched before the flick silently turned the screen off
 * again on the next save. The switch has its own row and its own endpoint.
 */
async function setEnabled(enabled: boolean): Promise<boolean> {
  const response = await api.put('/admin/connect-page/enabled', { enabled });
  return z.object({ enabled: z.boolean() }).parse(response.data).enabled;
}

export function ConnectScreenCard(): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canEdit = usePermissionStore((state) => state.hasPermission('subpage_config', 'edit'));

  const { data, isLoading } = useQuery({
    queryKey: CONNECT_PAGE_KEYS.all,
    queryFn: connectPageApi.get,
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setEnabled(enabled),
    onSuccess: (_written, enabled) => {
      void queryClient.invalidateQueries({ queryKey: CONNECT_PAGE_KEYS.all });
      toast.success(
        enabled ? t('connectScreen.turnedOn') : t('connectScreen.turnedOff'),
      );
    },
    onError: () => toast.error(t('connectScreen.saveFailed')),
  });

  const enabled = data?.config.connectScreenEnabled === true;
  // "Unknown" is not "off". A failed read used to render a confident off
  // position for a switch nobody had touched.
  const unknown = !isLoading && data === undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Link2 className="h-5 w-5" /> {t('connectScreen.title')}
        </CardTitle>
        <CardDescription>{t('connectScreen.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : unknown ? (
          <p className="text-sm text-muted-foreground">{t('connectScreen.unknown')}</p>
        ) : (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-muted/30 p-3">
            <div className="space-y-0.5">
              <Label className="text-sm">{t('connectScreen.label')}</Label>
              <p className="text-xs text-muted-foreground">
                {enabled ? t('connectScreen.hintOn') : t('connectScreen.hintOff')}
              </p>
            </div>
            <Switch
              checked={enabled}
              disabled={toggle.isPending || !canEdit}
              onCheckedChange={(next) => toggle.mutate(next)}
              aria-label={t('connectScreen.label')}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
