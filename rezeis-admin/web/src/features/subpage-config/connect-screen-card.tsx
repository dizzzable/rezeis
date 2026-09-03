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

const CONNECT_PAGE_KEYS = { all: ['admin', 'connect-page'] as const } as const;

/**
 * Deliberately shallow, and passthrough where the catalog lives.
 *
 * The panel API validates this config exhaustively on the way in; re-declaring
 * the whole catalog here would be a second copy of that schema, free to drift
 * from the first. This card only needs the one field it toggles, and it must
 * hand the rest back untouched.
 */
const connectPageSchema = z
  .object({ connectScreenEnabled: z.boolean().optional() })
  .passthrough();

type ConnectPageConfig = z.infer<typeof connectPageSchema>;

const connectPageApi = {
  async get(): Promise<{ config: ConnectPageConfig; stored: boolean }> {
    const response = await api.get('/admin/connect-page');
    return z.object({ config: connectPageSchema, stored: z.boolean() }).parse(response.data);
  },
  /**
   * Writes the switch and NOTHING else.
   *
   * It used to PUT the whole config back with one boolean changed, which meant
   * the first flick froze the built-in default catalog into the database
   * forever — no later improvement to it would ever reach this install — and a
   * catalog draft branched before the flick silently turned the screen off
   * again on the next save. The switch has its own row and its own endpoint.
   */
  async setEnabled(enabled: boolean): Promise<boolean> {
    const response = await api.put('/admin/connect-page/enabled', { enabled });
    return z.object({ enabled: z.boolean() }).parse(response.data).enabled;
  },
};

export function ConnectScreenCard(): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: CONNECT_PAGE_KEYS.all,
    queryFn: connectPageApi.get,
  });

  const toggle = useMutation({
    // The whole config goes back, not a patch: the API replaces it, and sending
    // only the flag would wipe the catalog the operator spent an hour on.
    mutationFn: (enabled: boolean) => connectPageApi.setEnabled(enabled),
    onSuccess: (_config, enabled) => {
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
              disabled={toggle.isPending}
              onCheckedChange={(next) => toggle.mutate(next)}
              aria-label={t('connectScreen.label')}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
