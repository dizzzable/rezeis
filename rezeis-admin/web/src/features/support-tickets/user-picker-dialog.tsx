import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Loader2, Search } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Pick the customer to open a thread with, instead of typing their identifier.
 *
 * WHY. Opening a ticket meant knowing a reference by heart — a reiwa id, a
 * telegram id or a login — and typing it correctly. That works when the
 * operator already has the person in front of them and fails the rest of the
 * time, which is most of the time: the operator generally knows *who* they want
 * ("the one who wrote a minute ago", "somebody on a paid plan") and not *which
 * string names them*.
 *
 * The filters answer those questions rather than offering the database's own
 * columns: who is here now, who has a subscription, and free text over
 * everything a person might be recognised by.
 *
 * PRESENCE COMES FROM THE SERVER. It is not computed here from `lastSeenAt`,
 * even though the row carries one. The user card next door used to do exactly
 * that with its own thresholds, and a second definition is how the same person
 * ends up green on one screen and amber on another. The server sends the
 * bucket; this only paints it.
 */

type Presence = 'online' | 'away' | 'offline'

interface PickableUser {
  readonly id: string
  readonly telegramId: string | null
  readonly username: string | null
  readonly email: string | null
  readonly name: string | null
  readonly login: string | null
  readonly isBlocked: boolean
  readonly presence: Presence
}

interface UserListResponse {
  readonly items: readonly PickableUser[]
  readonly total: number
}

const PRESENCE_DOT: Record<Presence, string> = {
  online: 'bg-emerald-500',
  away: 'bg-amber-500',
  offline: 'bg-transparent border border-muted-foreground/50',
}

/** The presence filters, in the order an operator reaches for them. */
const PRESENCE_FILTERS = ['any', 'online', 'away', 'offline'] as const
type PresenceFilter = (typeof PRESENCE_FILTERS)[number]

/** Subscription filters, kept to the three states that change who to write to. */
const SUBSCRIPTION_FILTERS = ['any', 'with', 'trial', 'without'] as const
type SubscriptionFilter = (typeof SUBSCRIPTION_FILTERS)[number]

export interface UserPickerDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** Receives the reference the compose form should send as `userRef`. */
  readonly onPick: (reference: string, label: string) => void
}

export function UserPickerDialog({ open, onOpenChange, onPick }: UserPickerDialogProps) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [presence, setPresence] = useState<PresenceFilter>('any')
  const [subscription, setSubscription] = useState<SubscriptionFilter>('any')

  // Typing a name should not be one request per keystroke against the busiest
  // table in the panel.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250)
    return () => clearTimeout(timer)
  }, [search])

  // Reopening should not show the previous operator's search still in the box.
  useEffect(() => {
    if (open) return
    setSearch('')
    setDebounced('')
    setPresence('any')
    setSubscription('any')
  }, [open])

  const params = useMemo(() => {
    const next: Record<string, string | number | boolean> = { limit: 40 }
    if (debounced.length > 0) next.search = debounced
    if (presence !== 'any') next.presence = presence
    if (subscription === 'with') next.hasSubscription = true
    if (subscription === 'without') next.hasSubscription = false
    if (subscription === 'trial') next.isTrial = true
    return next
  }, [debounced, presence, subscription])

  const { data, isFetching, isError } = useQuery({
    queryKey: ['support-user-picker', params],
    queryFn: async ({ signal }) =>
      (await api.get<UserListResponse>('/admin/users', { params, signal })).data,
    // Keeps the previous page on screen while the next one loads. Without it
    // every keystroke and every filter click emptied the list and the footer
    // read "Showing 0 of 0" — which looks like an answer, not like loading.
    placeholderData: keepPreviousData,
    // Only while the dialog is on screen: this is the users table, and a
    // background refetch behind a closed dialog buys nobody anything.
    enabled: open,
    staleTime: 15_000,
  })

  const users = data?.items ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('supportTicketsPage.userPicker.title')}</DialogTitle>
          <DialogDescription>
            {t('supportTicketsPage.userPicker.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('supportTicketsPage.userPicker.searchPlaceholder')}
              className="pl-8"
              autoComplete="off"
              autoFocus
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {PRESENCE_FILTERS.map((value) => (
              <FilterChip
                key={value}
                active={presence === value}
                onClick={() => setPresence(value)}
                label={t(`supportTicketsPage.userPicker.presence.${value}`)}
                dot={value === 'any' ? undefined : PRESENCE_DOT[value]}
              />
            ))}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {SUBSCRIPTION_FILTERS.map((value) => (
              <FilterChip
                key={value}
                active={subscription === value}
                onClick={() => setSubscription(value)}
                label={t(`supportTicketsPage.userPicker.subscription.${value}`)}
              />
            ))}
          </div>

          <ScrollArea className="h-72 rounded-md border">
            {isError ? (
              // Distinct from "nobody matches". A role with permission to open
              // a ticket but not to list users gets a 403 here, and reporting
              // that as an empty result told the operator their install had no
              // customers.
              <p className="px-3 py-10 text-center text-sm text-destructive">
                {t('supportTicketsPage.userPicker.failed')}
              </p>
            ) : users.length === 0 ? (
              <p className="px-3 py-10 text-center text-sm text-muted-foreground">
                {isFetching
                  ? t('supportTicketsPage.userPicker.loading')
                  : t('supportTicketsPage.userPicker.empty')}
              </p>
            ) : (
              <ul className="divide-y">
                {users.map((user) => {
                  const label = displayName(user)
                  return (
                    <li key={user.id}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
                        onClick={() => {
                          // ALWAYS the reiwa id, never the telegram id.
                          // Both are shapes the endpoint discriminates
                          // between, but `telegramId` is optional AND can be
                          // negative — this panel deliberately accepts and
                          // stores negative ids — and a negative id matches
                          // neither pattern upstream. The operator would pick a
                          // row from a list and be told their reference is
                          // malformed, with no user named and no remedy. The
                          // reiwa id is a CUID on every row, always present and
                          // always resolvable; `pickUserReference` upstream
                          // prefers it for the same reason.
                          onPick(user.id, label)
                          onOpenChange(false)
                        }}
                      >
                        <span
                          className={cn(
                            'h-2.5 w-2.5 shrink-0 rounded-full',
                            PRESENCE_DOT[user.presence],
                          )}
                          aria-label={t(
                            `supportTicketsPage.userPicker.presence.${user.presence}`,
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{label}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {secondaryLine(user)}
                          </span>
                        </span>
                        {user.isBlocked && (
                          <Badge variant="destructive" className="shrink-0">
                            {t('supportTicketsPage.userPicker.blocked')}
                          </Badge>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </ScrollArea>

          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            {isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
            {t(
              (data?.total ?? 0) > users.length
                ? 'supportTicketsPage.userPicker.shownCapped'
                : 'supportTicketsPage.userPicker.shown',
              { shown: users.length, total: data?.total ?? 0 },
            )}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function FilterChip({
  active,
  label,
  dot,
  onClick,
}: {
  readonly active: boolean
  readonly label: string
  readonly dot?: string
  readonly onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      {dot !== undefined && <span className={cn('h-2 w-2 rounded-full', dot)} />}
      {label}
    </button>
  )
}

/**
 * What to call this person, preferring what the operator would recognise.
 *
 * Falls all the way through to the telegram id rather than to an empty string:
 * a row with no name at all is still a row somebody has to be able to pick.
 */
function displayName(user: PickableUser): string {
  if (user.name && user.name.trim().length > 0) return user.name
  if (user.username) return `@${user.username}`
  if (user.login) return user.login
  if (user.email) return user.email
  return user.telegramId ?? user.id
}

/** Everything else that identifies them, so two similar names stay separable. */
function secondaryLine(user: PickableUser): string {
  const parts: string[] = []
  if (user.username && displayName(user) !== `@${user.username}`) parts.push(`@${user.username}`)
  if (user.login && displayName(user) !== user.login) parts.push(user.login)
  if (user.telegramId) parts.push(user.telegramId)
  return parts.length > 0 ? parts.join(' · ') : user.id
}
