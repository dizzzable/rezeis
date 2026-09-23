/**
 * DestinationBadge — compact pill rendering "where this button leads".
 *
 * Reads the synthesised `BotMapEdge.destination` discriminator and
 * resolves a friendly i18n label by destination kind. When the edge is
 * marked invalid by the composer (dangling shortId, unsafe URL,
 * empty target), we render a red error pill so the operator notices.
 */
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'

import type { BotMapEdge, BotMapNode } from '../types'

interface DestinationBadgeProps {
  readonly edge: BotMapEdge
  /**
   * Lookup the human name of the target node when the destination is
   * a screen. Optional — falls back to the shortId when not provided.
   */
  readonly nodesById?: ReadonlyMap<string, BotMapNode>
}

export function DestinationBadge({ edge, nodesById }: DestinationBadgeProps) {
  const { t } = useTranslation()

  if (!edge.valid) {
    // Say what is wrong where the composer knows it — the same words «Схема»
    // puts under a main-menu button with the same route.
    return (
      <Badge variant="destructive" className="text-[10px] font-normal">
        {t(invalidReasonKey(edge.reason))}
      </Badge>
    )
  }

  switch (edge.destination.kind) {
    case 'screen': {
      const target = nodesById?.get(edge.target)
      const name = target?.title ?? edge.destination.shortId
      return (
        <Badge variant="secondary" className="text-[10px] font-normal">
          {t('botMapPage.destination.screen', { name })}
        </Badge>
      )
    }
    case 'webApp':
      return (
        <Badge variant="secondary" className="text-[10px] font-normal">
          {t('botMapPage.destination.webApp', { route: edge.destination.route })}
        </Badge>
      )
    case 'url':
      return (
        <Badge variant="outline" className="text-[10px] font-normal">
          {t('botMapPage.destination.url', { host: edge.destination.host })}
        </Badge>
      )
    case 'site':
      return (
        <Badge variant="outline" className="text-[10px] font-normal">
          {t('botMapPage.destination.site', { path: edge.destination.path })}
        </Badge>
      )
    case 'chat':
      // With a screen to fall back to: both roads, as «Схема» says them.
      return (
        <Badge variant="outline" className="text-[10px] font-normal">
          {edge.destination.fallbackScreen === undefined
            ? t('botMapPage.destination.chat')
            : t('botMapPage.destination.chatOrScreen', { name: edge.destination.fallbackScreen })}
        </Badge>
      )
    case 'callback':
      return (
        <Badge variant="outline" className="text-[10px] font-normal">
          {t('botMapPage.destination.callback', {
            id: edge.destination.id || '∅',
          })}
        </Badge>
      )
    case 'back':
      return (
        <Badge variant="outline" className="text-[10px] font-normal">
          {t('botMapPage.destination.back')}
        </Badge>
      )
    case 'mainMenu':
      return (
        <Badge variant="outline" className="text-[10px] font-normal">
          {t('botMapPage.destination.mainMenu')}
        </Badge>
      )
  }
}

/** The red badge's words for why the composer marked an edge broken. */
function invalidReasonKey(reason: string | undefined): string {
  switch (reason) {
    case 'unsafe-url':
    case 'unsafe-webapp':
      return 'botMapPage.destination.unsafeUrl'
    case 'unanswered-callback':
      return 'botMapPage.destination.unanswered'
    case 'unknown-shortid':
      return 'botMapPage.destination.missingScreen'
    case 'unknown-mini-app-route':
      return 'botMapPage.destination.missingPage'
    default:
      return 'botMapPage.destination.invalid'
  }
}
