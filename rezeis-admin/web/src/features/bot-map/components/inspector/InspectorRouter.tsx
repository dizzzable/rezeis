/**
 * InspectorRouter — picks the right editor for the selected node.
 *
 * Single switch on `node.kind` so the page-level component doesn't need
 * to know which editor handles which kind. When no node is selected the
 * router renders an empty-state hint pointing at the rail.
 */
import { useTranslation } from 'react-i18next'

import { MainMenuSystemPanel } from '@/features/bot-flow/components/MainMenuSystemPanel'
import { SystemScreenPanel } from '@/features/bot-flow/components/SystemScreenPanel'
import { systemScreenById } from '@/features/bot-flow/system-screens'

import type { BotMapNode } from '../../types'
import { GraphScreenEditor } from './GraphScreenEditor'
import { MiniAppTerminalView } from './MiniAppTerminalView'
import { NotificationEditor } from './NotificationEditor'
import { ReplyButtonEditor } from './ReplyButtonEditor'

interface InspectorRouterProps {
  readonly node: BotMapNode | null
}

export function InspectorRouter({ node }: InspectorRouterProps) {
  const { t } = useTranslation()

  if (node === null) {
    return (
      <p className="rounded-lg border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">
        {t('botMapPage.inspector.empty')}
      </p>
    )
  }

  // The main menu and the bot's screens with no block get the panels «Схема»
  // shows for them — the same components, so the two tabs cannot drift.
  switch (node.kind) {
    case 'graph-screen':
      return <GraphScreenEditor node={node} />
    case 'reply-keyboard':
      return (
        <div className="space-y-4">
          <ReplyButtonEditor node={node} />
          <MainMenuSystemPanel />
        </div>
      )
    case 'notification':
      return <NotificationEditor node={node} />
    case 'mini-app-terminal':
      return <MiniAppTerminalView node={node} />
    case 'system-screen': {
      const screen = systemScreenById(node.screenId)
      return screen === null ? null : <SystemScreenPanel key={screen.id} screen={screen} />
    }
  }
}
