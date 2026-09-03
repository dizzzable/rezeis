import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Globe, RotateCcw, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { FadeIn } from '@/lib/motion';

import {
  SUBPAGE_CONFIG_KEYS,
  SUBPAGE_GUIDE_BLOCK_TYPES,
  SUBPAGE_INFO_BLOCK_TYPES,
  subpageConfigApi,
  subpageConfigSchema,
  type SubpageConfig,
} from './subpage-config-api';
import { ConnectScreenCard } from './connect-screen-card';
import { SubpageConfigClients } from './subpage-config-clients';
import { SubpageIcons, SubpageTheme, SubpageTranslations } from './subpage-config-assets';

export default function SubpageConfigPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: SUBPAGE_CONFIG_KEYS.all,
    queryFn: () => subpageConfigApi.get(),
  });

  const [config, setConfig] = useState<SubpageConfig | null>(null);
  const [rawText, setRawText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    // Seed the editable local editor state once the async config query lands.
    // Sanctioned "sync external data into local editable state" case.
    if (data?.config) {
      /* eslint-disable react-hooks/set-state-in-effect -- TODO: refactor to a keyed remount if the editor grows */
      setConfig(data.config);
      setRawText(JSON.stringify(data.config, null, 2));
      setJsonError(null);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (next: SubpageConfig) => subpageConfigApi.replace(next),
    onSuccess: (saved) => {
      setConfig(saved);
      setRawText(JSON.stringify(saved, null, 2));
      setJsonError(null);
      void queryClient.invalidateQueries({ queryKey: SUBPAGE_CONFIG_KEYS.all });
      toast.success(t('subpageConfigPage.toasts.saved'));
    },
    onError: () => toast.error(t('subpageConfigPage.toasts.saveFailed')),
  });

  function patchConfig(next: SubpageConfig): void {
    setConfig(next);
    setRawText(JSON.stringify(next, null, 2));
    setJsonError(null);
  }

  function onRawChange(text: string): void {
    setRawText(text);
    try {
      const parsed: unknown = JSON.parse(text);
      const result = subpageConfigSchema.safeParse(parsed);
      if (result.success) {
        setConfig(result.data);
        setJsonError(null);
      } else {
        setJsonError(
          result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleSave(): void {
    if (!config) return;
    if (jsonError) {
      toast.error(t('subpageConfigPage.toasts.fixJson'));
      return;
    }
    const result = subpageConfigSchema.safeParse(config);
    if (!result.success) {
      toast.error(t('subpageConfigPage.toasts.invalid'));
      return;
    }
    saveMutation.mutate(result.data);
  }

  function handleReset(): void {
    if (data?.config) {
      patchConfig(data.config);
      toast.success(t('subpageConfigPage.toasts.reset'));
    }
  }

  function handleDownload(): void {
    if (!config) return;
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'subpage-config.json';
    a.click();
    URL.revokeObjectURL(url);
    toast.success(t('subpageConfigPage.toasts.downloaded'));
  }

  if (isLoading || !config) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <Globe className="h-6 w-6" /> {t('subpageConfigPage.title')}
            </h1>
            <p className="text-muted-foreground">{t('subpageConfigPage.subtitle')}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleDownload}>
              <Download className="mr-2 h-4 w-4" /> {t('subpageConfigPage.actions.download')}
            </Button>
            <Button variant="outline" onClick={handleReset} disabled={saveMutation.isPending}>
              <RotateCcw className="mr-2 h-4 w-4" /> {t('subpageConfigPage.actions.reset')}
            </Button>
            <Button onClick={handleSave} disabled={saveMutation.isPending || jsonError !== null}>
              <Save className="mr-2 h-4 w-4" /> {t('subpageConfigPage.actions.save')}
            </Button>
          </div>
        </div>
      </FadeIn>

      {/* The switch first: it is the decision about whether anybody sees the
          catalog below it, and it stays usable while the catalog is half-written. */}
      <FadeIn>
        <ConnectScreenCard />
      </FadeIn>

      {!data?.stored && (
        <FadeIn>
          <Card className="border-amber-500/40 bg-amber-500/5">
            <CardContent className="py-3 text-sm text-muted-foreground">
              {t('subpageConfigPage.usingDefault')}
            </CardContent>
          </Card>
        </FadeIn>
      )}

      <Tabs defaultValue="general">
        <TabsList className="flex-wrap">
          <TabsTrigger value="general">{t('subpageConfigPage.tabs.general')}</TabsTrigger>
          <TabsTrigger value="clients">{t('subpageConfigPage.tabs.clients')}</TabsTrigger>
          <TabsTrigger value="icons">{t('subpageConfigPage.tabs.icons')}</TabsTrigger>
          <TabsTrigger value="translations">{t('subpageConfigPage.tabs.translations')}</TabsTrigger>
          <TabsTrigger value="advanced">{t('subpageConfigPage.tabs.advanced')}</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-6 pt-4">
          {/* Branding */}
          <Card>
            <CardHeader>
              <CardTitle>{t('subpageConfigPage.branding.title')}</CardTitle>
              <CardDescription>{t('subpageConfigPage.branding.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label={t('subpageConfigPage.branding.name')}>
                <Input
                  value={config.brandingSettings.title}
                  onChange={(e) =>
                    patchConfig({
                      ...config,
                      brandingSettings: { ...config.brandingSettings, title: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label={t('subpageConfigPage.branding.supportUrl')}>
                <Input
                  value={config.brandingSettings.supportUrl}
                  placeholder="https://t.me/yoursupport"
                  onChange={(e) =>
                    patchConfig({
                      ...config,
                      brandingSettings: { ...config.brandingSettings, supportUrl: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label={t('subpageConfigPage.branding.logoUrl')} className="sm:col-span-2">
                <Input
                  value={config.brandingSettings.logoUrl}
                  placeholder="https://.../logo.svg"
                  onChange={(e) =>
                    patchConfig({
                      ...config,
                      brandingSettings: { ...config.brandingSettings, logoUrl: e.target.value },
                    })
                  }
                />
              </Field>
            </CardContent>
          </Card>

          {/* Base settings */}
          <Card>
            <CardHeader>
              <CardTitle>{t('subpageConfigPage.base.title')}</CardTitle>
              <CardDescription>{t('subpageConfigPage.base.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label={t('subpageConfigPage.base.metaTitle')}>
                <Input
                  value={config.baseSettings.metaTitle}
                  onChange={(e) =>
                    patchConfig({
                      ...config,
                      baseSettings: { ...config.baseSettings, metaTitle: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label={t('subpageConfigPage.base.metaDescription')}>
                <Input
                  value={config.baseSettings.metaDescription}
                  onChange={(e) =>
                    patchConfig({
                      ...config,
                      baseSettings: { ...config.baseSettings, metaDescription: e.target.value },
                    })
                  }
                />
              </Field>
              <ToggleRow
                label={t('subpageConfigPage.base.showConnectionKeys')}
                checked={config.baseSettings.showConnectionKeys}
                onCheckedChange={(v) =>
                  patchConfig({
                    ...config,
                    baseSettings: { ...config.baseSettings, showConnectionKeys: v },
                  })
                }
              />
              <ToggleRow
                label={t('subpageConfigPage.base.hideGetLinkButton')}
                checked={config.baseSettings.hideGetLinkButton}
                onCheckedChange={(v) =>
                  patchConfig({
                    ...config,
                    baseSettings: { ...config.baseSettings, hideGetLinkButton: v },
                  })
                }
              />
            </CardContent>
          </Card>

          {/* UI config */}
          <Card>
            <CardHeader>
              <CardTitle>{t('subpageConfigPage.ui.title')}</CardTitle>
              <CardDescription>{t('subpageConfigPage.ui.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label={t('subpageConfigPage.ui.infoBlock')}>
                <Select
                  value={config.uiConfig.subscriptionInfoBlockType}
                  onValueChange={(v) =>
                    patchConfig({
                      ...config,
                      uiConfig: { ...config.uiConfig, subscriptionInfoBlockType: v },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUBPAGE_INFO_BLOCK_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(`subpageConfigPage.ui.infoBlockTypes.${type}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('subpageConfigPage.ui.guideBlock')}>
                <Select
                  value={config.uiConfig.installationGuidesBlockType}
                  onValueChange={(v) =>
                    patchConfig({
                      ...config,
                      uiConfig: { ...config.uiConfig, installationGuidesBlockType: v },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUBPAGE_GUIDE_BLOCK_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(`subpageConfigPage.ui.guideBlockTypes.${type}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </CardContent>
          </Card>

          <SubpageTheme config={config} onChange={patchConfig} />
        </TabsContent>

        <TabsContent value="clients" className="pt-4">
          <SubpageConfigClients config={config} onChange={patchConfig} />
        </TabsContent>

        <TabsContent value="icons" className="pt-4">
          <SubpageIcons config={config} onChange={patchConfig} />
        </TabsContent>

        <TabsContent value="translations" className="pt-4">
          <SubpageTranslations config={config} onChange={patchConfig} />
        </TabsContent>

        <TabsContent value="advanced" className="space-y-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('subpageConfigPage.advanced.title')}</CardTitle>
              <CardDescription>{t('subpageConfigPage.advanced.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                value={rawText}
                spellCheck={false}
                onChange={(e) => onRawChange(e.target.value)}
                className="min-h-[420px] font-mono text-xs"
                aria-label={t('subpageConfigPage.advanced.title')}
              />
              {jsonError && <p className="text-sm text-destructive">{jsonError}</p>}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <Label className="cursor-pointer">{label}</Label>
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
    </div>
  );
}
