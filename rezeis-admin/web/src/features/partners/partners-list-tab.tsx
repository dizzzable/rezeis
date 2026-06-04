import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ArrowDownAZ, ArrowUpAZ, Copy, Filter, MoreHorizontal, Search, Settings2, UserSearch } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { FadeIn } from '@/lib/motion'

import { AnimatedCounter } from './animated-counter'
import PartnerDetailSheet from './partner-detail-sheet'
import {
  formatKopecksCompact,
  formatNumber,
} from './partner-formatters'
import { ListPartnersSort, Partner } from './partners-api'
import { usePartnerMutations, usePartnersList } from './partners-queries'

const PAGE_SIZE = 25

export default function PartnersListTab() {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState<'all' | 'true' | 'false'>('all')
  const [sort, setSort] = useState<ListPartnersSort>('totalEarned')
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Partner | null>(null)

  const { data, isLoading } = usePartnersList({
    search: search.trim() || undefined,
    isActive: activeFilter === 'all' ? undefined : activeFilter,
    sort,
    order,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  })

  const { togglePartner } = usePartnerMutations()

  function handleToggle(partnerId: string) {
    togglePartner.mutate(partnerId, {
      onSuccess: () => toast.success(t('partnersDetail.toasts.statusUpdated')),
      onError: () => toast.error(t('partnersDetail.toasts.statusFailed')),
    })
  }

  return (
    <FadeIn className="mt-4 space-y-4">
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={t('partnersList.searchPlaceholder')}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  setPage(0)
                }}
                className="pl-9"
                aria-label={t('partnersList.searchAria')}
              />
            </div>
            <Select
              value={activeFilter}
              onValueChange={(value) => {
                setActiveFilter(value as 'all' | 'true' | 'false')
                setPage(0)
              }}
            >
              <SelectTrigger className="w-44" aria-label={t('partnersList.statusAria')}>
                <Filter className="h-3.5 w-3.5 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('partnersList.filter.all')}</SelectItem>
                <SelectItem value="true">{t('partnersList.filter.active')}</SelectItem>
                <SelectItem value="false">{t('partnersList.filter.inactive')}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={sort}
              onValueChange={(value) => setSort(value as ListPartnersSort)}
            >
              <SelectTrigger className="w-44" aria-label={t('partnersList.sortAria')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="totalEarned">
                  {t('partnersList.sort.totalEarned')}
                </SelectItem>
                <SelectItem value="balance">{t('partnersList.sort.balance')}</SelectItem>
                <SelectItem value="totalWithdrawn">
                  {t('partnersList.sort.totalWithdrawn')}
                </SelectItem>
                <SelectItem value="createdAt">{t('partnersList.sort.createdAt')}</SelectItem>
                <SelectItem value="updatedAt">{t('partnersList.sort.updatedAt')}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setOrder((current) => (current === 'desc' ? 'asc' : 'desc'))}
              aria-label={t('partnersList.orderAria')}
            >
              {order === 'desc' ? (
                <ArrowDownAZ className="h-4 w-4" />
              ) : (
                <ArrowUpAZ className="h-4 w-4" />
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !data || data.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {t('partnersList.empty')}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('partnersList.columns.partner')}</TableHead>
                  <TableHead className="text-right">
                    {t('partnersList.columns.balance')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('partnersList.columns.earned')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('partnersList.columns.withdrawn')}
                  </TableHead>
                  <TableHead className="text-center">
                    {t('partnersList.columns.referrals')}
                  </TableHead>
                  <TableHead className="text-center">
                    {t('partnersList.columns.tier')}
                  </TableHead>
                  <TableHead className="text-center">
                    {t('partnersList.columns.status')}
                  </TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((partner) => (
                  <TableRow key={partner.id}>
                    <TableCell>
                      <p className="text-sm font-medium leading-tight">
                        {partner.user.name ?? partner.user.username ?? '—'}
                      </p>
                      <p className="text-[11px] text-muted-foreground font-mono">
                        @{partner.user.username ?? partner.user.telegramId ?? '—'}
                      </p>
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-mono text-sm">
                      <AnimatedCounter
                        value={partner.balance / 100}
                        format={(v) =>
                          v.toLocaleString('ru-RU', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })
                        }
                      />
                      <span className="ml-1 text-muted-foreground">₽</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-mono text-sm text-emerald-500 font-semibold">
                      {formatKopecksCompact(partner.totalEarned)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-mono text-xs text-muted-foreground">
                      {formatKopecksCompact(partner.totalWithdrawn)}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="secondary">
                        <AnimatedCounter
                          value={partner.referralsCount}
                          format={formatNumber}
                        />
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      {partner.useGlobalSettings ? (
                        <Badge variant="outline" className="text-[10px]">
                          {t('partnersList.tier.global')}
                        </Badge>
                      ) : (
                        <Badge variant="default" className="text-[10px]">
                          {t('partnersList.tier.individual')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={partner.isActive}
                        onCheckedChange={() => handleToggle(partner.id)}
                        aria-label={t('partnersList.toggleAria')}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => setSelected(partner)}
                        >
                          <Settings2 className="h-3.5 w-3.5 mr-1" />
                          {t('partnersList.manage')}
                        </Button>
                        <PartnerRowActions partner={partner} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {t('partnersList.page', { page: page + 1 })} ·{' '}
          {data ? data.length : 0} {t('partnersList.shown')}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage(Math.max(0, page - 1))}
          >
            {t('partnersList.prev')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!data || data.length < PAGE_SIZE}
            onClick={() => setPage(page + 1)}
          >
            {t('partnersList.next')}
          </Button>
        </div>
      </div>

      <PartnerDetailSheet
        partner={selected}
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      />
    </FadeIn>
  )
}

function PartnerRowActions({ partner }: { readonly partner: Partner }) {
  const { t } = useTranslation()

  function copy(value: string | null, label: string) {
    if (!value) return
    navigator.clipboard.writeText(value).then(
      () => toast.success(t('partnersList.actions.copied', { label })),
      () => toast.error(t('partnersList.actions.copyFailed')),
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t('partnersList.actions.aria')}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {partner.user.telegramId && (
          <DropdownMenuItem asChild>
            <Link to={`/users/${partner.user.telegramId}`}>
              <UserSearch className="h-3.5 w-3.5 mr-2" />
              {t('partnersList.actions.openInUsers')}
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => copy(partner.id, 'partner ID')}
        >
          <Copy className="h-3.5 w-3.5 mr-2" />
          {t('partnersList.actions.copyPartnerId')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => copy(partner.user.id, 'user ID')}
        >
          <Copy className="h-3.5 w-3.5 mr-2" />
          {t('partnersList.actions.copyUserId')}
        </DropdownMenuItem>
        {partner.user.telegramId && (
          <DropdownMenuItem
            onClick={() => copy(partner.user.telegramId, 'telegram ID')}
          >
            <Copy className="h-3.5 w-3.5 mr-2" />
            {t('partnersList.actions.copyTelegramId')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
