/**
 * Catalog tab — read-only view over the Remnawave catalog surface:
 *   • Config profiles (xray-style profiles with inbounds & nodes)
 *   • Subscription templates (XRAY_JSON / CLASH / SINGBOX / STASH / MIHOMO)
 *   • Public landing pages (`/sub/<short>` browser experience configs)
 *   • Reusable snippets that templates can include
 *
 * Each section is a compact card. Mutations are intentionally out-of-scope
 * for this iteration — operators get visibility today, an editor lands
 * once we wire up template validation.
 */
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronRight,
  FileCode2,
  FileJson,
  Globe,
  Layers,
  Loader2,
  ScrollText,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { remnawaveApi } from '../remnawave-api'
import { NodeFlag } from '../remnawave-flags'
import { KEYS } from '../remnawave-query-keys'
import { TabHeader } from '../shared/tab-header'

export function CatalogTab() {
  const { t } = useTranslation()
  const { data: profiles, isLoading: loadingProfiles } = useQuery({
    queryKey: KEYS.configProfiles,
    queryFn: remnawaveApi.getConfigProfiles,
  })
  const { data: templates, isLoading: loadingTemplates } = useQuery({
    queryKey: KEYS.subscriptionTemplates,
    queryFn: remnawaveApi.getSubscriptionTemplates,
  })
  const { data: pages, isLoading: loadingPages } = useQuery({
    queryKey: KEYS.subscriptionPageConfigs,
    queryFn: remnawaveApi.getSubscriptionPageConfigs,
  })
  const { data: snippets, isLoading: loadingSnippets } = useQuery({
    queryKey: KEYS.snippets,
    queryFn: remnawaveApi.getSnippets,
  })
  const { data: settings } = useQuery({
    queryKey: KEYS.subscriptionSettings,
    queryFn: remnawaveApi.getSubscriptionSettings,
  })

  return (
    <div className="space-y-4">
      <TabHeader
        title={t('remnaWavePage.tabs.catalog')}
        subtitle={t('remnaWavePage.catalog.subtitle')}
      />

      {/* Top: subscription settings strip — one wide card with toggles */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <FileJson className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('remnaWavePage.catalog.settings.title')}
          </CardTitle>
          <CardDescription className="text-xs">
            {settings?.profileTitle ? settings.profileTitle : t('remnaWavePage.catalog.settings.untitled')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {settings ? (
            <div className="flex flex-wrap gap-2">
              <FlagBadge label={t('remnaWavePage.catalog.settings.profileUpdate', { hours: settings.profileUpdateInterval })} active />
              <FlagBadge label={t('remnaWavePage.catalog.settings.serveJson')} active={settings.serveJsonAtBaseSubscription} />
              <FlagBadge label={t('remnaWavePage.catalog.settings.profileWebpage')} active={settings.isProfileWebpageUrlEnabled} />
              <FlagBadge label={t('remnaWavePage.catalog.settings.showRemarks')} active={settings.isShowCustomRemarks} />
              <FlagBadge label={t('remnaWavePage.catalog.settings.randomizeHosts')} active={settings.randomizeHosts} />
              <FlagBadge label={t('remnaWavePage.catalog.settings.responseRules')} active={settings.hasResponseRules} />
              <FlagBadge label={t('remnaWavePage.catalog.settings.happAnnounce')} active={settings.hasHappAnnounce} />
              <FlagBadge label={t('remnaWavePage.catalog.settings.happRouting')} active={settings.hasHappRouting} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('remnaWavePage.catalog.settings.empty')}</p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Config profiles */}
        <SectionCard
          icon={Layers}
          title={t('remnaWavePage.catalog.profiles.title')}
          description={t('remnaWavePage.catalog.profiles.description', { count: profiles?.length ?? 0 })}
          loading={loadingProfiles}
          empty={!profiles || profiles.length === 0}
          emptyText={t('remnaWavePage.catalog.profiles.empty')}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('remnaWavePage.catalog.columns.name')}</TableHead>
                <TableHead className="text-right">{t('remnaWavePage.catalog.profiles.inbounds')}</TableHead>
                <TableHead className="text-right">{t('remnaWavePage.catalog.profiles.nodes')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles?.map((profile) => (
                <TableRow key={profile.uuid}>
                  <TableCell>
                    <p className="truncate font-medium">{profile.name}</p>
                    <p className="font-mono text-[10px] text-muted-foreground/70">{profile.uuid.slice(0, 8)}…</p>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{profile.inbounds.length}</TableCell>
                  <TableCell className="text-right">
                    <div className="ml-auto flex max-w-fit items-center gap-1">
                      <span className="tabular-nums">{profile.nodes.length}</span>
                      {profile.nodes.length > 0 ? (
                        <div className="flex items-center -space-x-1">
                          {profile.nodes.slice(0, 4).map((n) => (
                            <NodeFlag key={n.uuid} code={n.countryCode} title={n.name} className="h-3 w-4" />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionCard>

        {/* Subscription templates */}
        <SectionCard
          icon={FileCode2}
          title={t('remnaWavePage.catalog.templates.title')}
          description={t('remnaWavePage.catalog.templates.description', { count: templates?.length ?? 0 })}
          loading={loadingTemplates}
          empty={!templates || templates.length === 0}
          emptyText={t('remnaWavePage.catalog.templates.empty')}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('remnaWavePage.catalog.columns.name')}</TableHead>
                <TableHead>{t('remnaWavePage.catalog.templates.type')}</TableHead>
                <TableHead className="text-right">{t('remnaWavePage.catalog.templates.payload')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates?.map((template) => (
                <TableRow key={template.uuid}>
                  <TableCell className="font-medium">{template.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="px-1.5 text-[10px] font-normal">
                      {template.templateType}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {template.hasYaml ? (
                      <Badge variant="success" className="px-1.5 text-[10px] font-normal">
                        {t('remnaWavePage.catalog.templates.populated')}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="px-1.5 text-[10px] font-normal">
                        {t('remnaWavePage.catalog.templates.default')}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionCard>

        {/* Subscription pages */}
        <SectionCard
          icon={Globe}
          title={t('remnaWavePage.catalog.pages.title')}
          description={t('remnaWavePage.catalog.pages.description', { count: pages?.length ?? 0 })}
          loading={loadingPages}
          empty={!pages || pages.length === 0}
          emptyText={t('remnaWavePage.catalog.pages.empty')}
        >
          {/* The per-page subtitle used to render `page.title`, a field neither
              2.7.4 nor 2.8.0 sends — so it never appeared on any panel. The
              row's real content is its name, its view position and whether it
              carries a (panel-opaque) config blob. */}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 text-right">{t('remnaWavePage.catalog.columns.position')}</TableHead>
                <TableHead>{t('remnaWavePage.catalog.columns.name')}</TableHead>
                <TableHead className="text-right">{t('remnaWavePage.catalog.columns.config')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pages?.map((page) => (
                <TableRow key={page.uuid}>
                  <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                    {page.viewPosition}
                  </TableCell>
                  <TableCell>
                    <p className="font-medium">{page.name}</p>
                    <p className="font-mono text-[10px] text-muted-foreground/70">{page.uuid.slice(0, 8)}…</p>
                  </TableCell>
                  <TableCell className="text-right">
                    <ConfigBadge configured={page.hasConfig} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionCard>

        {/* Snippets */}
        <SectionCard
          icon={ScrollText}
          title={t('remnaWavePage.catalog.snippets.title')}
          description={t('remnaWavePage.catalog.snippets.description', { count: snippets?.length ?? 0 })}
          loading={loadingSnippets}
          empty={!snippets || snippets.length === 0}
          emptyText={t('remnaWavePage.catalog.snippets.empty')}
        >
          {/* A snippet is `{ name, snippet }` upstream — no uuid, no type, no
              description. `key` was `snippet.uuid`, which mapped to `''` for
              every row: two snippets were enough for React to see duplicate
              keys. `name` is the record's only identity and is now the key. */}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('remnaWavePage.catalog.columns.name')}</TableHead>
                <TableHead className="text-right">{t('remnaWavePage.catalog.snippets.entries')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snippets?.map((snippet) => (
                <TableRow key={snippet.name}>
                  <TableCell>
                    <p className="font-medium">{snippet.name}</p>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                    {snippet.entriesCount ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionCard>
      </div>
    </div>
  )
}

interface SectionCardProps {
  readonly icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
  readonly title: string
  readonly description: string
  readonly loading: boolean
  readonly empty: boolean
  readonly emptyText: string
  readonly children: React.ReactNode
}

function SectionCard({ icon: Icon, title, description, loading, empty, emptyText, children }: SectionCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
          {title}
        </CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {loading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : empty ? (
          <p className="px-6 pb-4 text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  )
}

/**
 * "Does this row carry a config blob" — the only thing either spec says about
 * `config` / `pluginConfig`, both of which are declared `{"nullable": true}`
 * with no type at all.
 */
function ConfigBadge({ configured }: { configured: boolean }) {
  const { t } = useTranslation()
  return (
    <Badge variant={configured ? 'success' : 'outline'} className="px-1.5 text-[10px] font-normal">
      {configured
        ? t('remnaWavePage.catalog.columns.configured')
        : t('remnaWavePage.catalog.columns.configEmpty')}
    </Badge>
  )
}

function FlagBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <Badge
      variant={active ? 'success' : 'outline'}
      className="gap-1 px-2 text-[11px] font-normal"
    >
      {active ? <ChevronRight className="h-3 w-3" aria-hidden /> : null}
      {label}
    </Badge>
  )
}
