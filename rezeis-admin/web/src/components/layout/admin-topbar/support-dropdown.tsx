import { useTranslation } from 'react-i18next'
import { Heart, Wallet } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const CRYPTO_ADDRESS = 'TNmxGN8iL5p2yfreNF1DtCEzpQCLuVZjeR'

/**
 * Same destination as the reiwa bot's «Поддержать разработчика» button
 * (`src/bot/lib/startup-notice.ts`). The two live in separate repositories and
 * ship as separate images, so they can only be kept in step by being changed
 * together — which is the whole reason this is a named constant rather than an
 * address buried in the markup below.
 */
const DONATE_URL = 'https://dalink.to/dizzzable'

/**
 * Topbar widget: opens a dropdown with project support links
 * (donation page, crypto wallet copy-to-clipboard).
 */
export function SupportDropdown() {
  const { t } = useTranslation()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('adminShell.support.label')}>
          <Heart className="h-4 w-4 text-red-500" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{t('adminShell.support.title')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a
            href={DONATE_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2"
          >
            <Heart className="h-3.5 w-3.5 text-pink-500" />
            {t('adminShell.support.donate')}
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            navigator.clipboard?.writeText(CRYPTO_ADDRESS)
          }}
          className="flex items-center gap-2"
        >
          <Wallet className="h-3.5 w-3.5 text-blue-500" />
          <div className="flex flex-col">
            <span className="text-xs">{t('adminShell.support.crypto')}</span>
            <code className="text-[10px] text-muted-foreground font-mono truncate max-w-44">
              {CRYPTO_ADDRESS}
            </code>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          <span className="text-[10px] text-muted-foreground">
            {t('adminShell.support.thanks')}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
