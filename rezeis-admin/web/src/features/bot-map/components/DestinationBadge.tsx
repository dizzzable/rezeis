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
    if (edge.reason === 'unsafe-url' || edge.reason === 'unsafe-webapp') {
      return (
        <Badge variant="destructive" className="text-[10px] font-normal">
          {t('botMapPage.destination.unsafeUrl')}
        </Badge>
      )
    }
    return (
      <Badge variant="destructive" className="text-[10px] font-normal">
        {t('botMapPage.destination.invalid')}
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
    case 'chat':
      return (
        <Badge variant="outline" className="text-[10px] font-normal">
          {t('botMapPage.destination.chat')}
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
