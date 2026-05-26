/**
 * Infra-tab orchestrator. Houses Nodes / Hosts / Squads as a horizontal
 * sub-tab strip — operators rarely look at Hosts and Squads in the same
 * frame as Nodes, so we keep them at one click each.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, Network, Users2 } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { TabHeader } from '../shared/tab-header'

import { InfraHostsSection } from './infra-hosts-section'
import { InfraNodesSection } from './infra-nodes-section'
import { InfraSquadsSection } from './infra-squads-section'

export function InfraTab() {
  const { t } = useTranslation()
  const [active, setActive] = useState<'nodes' | 'hosts' | 'squads'>('nodes')

  const subtitle =
    active === 'nodes'
      ? t('remnaWavePage.infra.subtitle.nodes')
      : active === 'hosts'
        ? t('remnaWavePage.infra.subtitle.hosts')
        : t('remnaWavePage.infra.subtitle.squads')

  return (
    <div className="space-y-4">
      <TabHeader title={t('remnaWavePage.tabs.infra')} subtitle={subtitle} />

      <Tabs value={active} onValueChange={(v) => setActive(v as 'nodes' | 'hosts' | 'squads')}>
        <TabsList>
          <TabsTrigger value="nodes" className="gap-1.5">
            <Network className="h-3.5 w-3.5" aria-hidden />
            {t('remnaWavePage.tabs.nodes')}
          </TabsTrigger>
          <TabsTrigger value="hosts" className="gap-1.5">
            <Globe className="h-3.5 w-3.5" aria-hidden />
            {t('remnaWavePage.tabs.hosts')}
          </TabsTrigger>
          <TabsTrigger value="squads" className="gap-1.5">
            <Users2 className="h-3.5 w-3.5" aria-hidden />
            {t('remnaWavePage.tabs.squads')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="nodes" className="mt-4">
          <InfraNodesSection />
        </TabsContent>
        <TabsContent value="hosts" className="mt-4">
          <InfraHostsSection />
        </TabsContent>
        <TabsContent value="squads" className="mt-4">
          <InfraSquadsSection />
        </TabsContent>
      </Tabs>
    </div>
  )
}
