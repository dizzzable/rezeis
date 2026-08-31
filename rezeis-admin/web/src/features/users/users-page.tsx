/**
 * Users page — two-panel layout (altshop-style):
 *
 *   ┌─────────────────┬──────────────────────────────────────────┐
 *   │  Left panel     │  Right panel                             │
 *   │  (user list +   │  (selected user detail + actions)        │
 *   │   search)       │                                          │
 *   │                 │                                          │
 *   └─────────────────┴──────────────────────────────────────────┘
 *
 * Left panel: search input + scrollable user list (fetched from
 * the admin search endpoint). Clicking a user selects them.
 *
 * Right panel: full user detail with all available actions,
 * rendered inline (no separate route needed).
 */

import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Search, Users as UsersIcon, Plus, Loader2, ListChecks, ArrowLeft, Download, Flag, UserX } from 'lucide-react'

import { api } from '@/lib/api'
import { toast } from 'sonner'
import { PermissionGate } from '@/features/rbac'
import { downloadCsv } from '@/features/partners/csv-download'
import { UsersFilterPanel } from './users-filter-panel'

// Ленивый, как и на прежнем месте: вкладка со списком заблокированных
// личностей тянет свой диалог и таблицу, а открывают её редко.
const BlockedIdentitiesTab = lazy(
  () => import('@/features/blocked-identities/blocked-identities-page'),
)
import {
  countActiveFilters,
  filtersFromParams,
  filtersToParams,
  type UserFilters,
} from './users-filters'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { cn } from '@/lib/utils'
import { getErrorMessage } from '@/lib/http-errors'
import { FadeIn } from '@/lib/motion'
import { useTabSync } from '@/lib/use-tab-sync'
import { HUB_TABS } from '@/components/layout/admin-nav-config'
import { useIsMobile } from '@/lib/use-is-mobile'
import { withFeatureBundle } from '@/i18n/i18n'
import { PageTitle } from '@/components/layout/page-title'

const UserDetailPanel = lazy(
  withFeatureBundle('userDetail', () => import('./user-detail-panel')),
)

const BulkUsersTab = lazy(() => import('@/features/users/bulk-users-page'))

const ALLOWED_TABS = HUB_TABS['/users']

/**
 * How long typing has to stop before the list follows it.
 *
 * Short enough that it feels like the list is filtering as you type, long
 * enough that a nine-character login is one request rather than nine. The
 * search hits Postgres with an `OR` across five columns, so the difference
 * matters on a busy panel.
 */
const SEARCH_DEBOUNCE_MS = 300
type UsersTab = (typeof ALLOWED_TABS)[number]

function getUserStatusClass(user: { isBlocked: boolean; lastSeenAt?: string | null }): string {
  if (user.isBlocked) return 'bg-destructive text-destructive'
  const now = Date.now()
  const lastSeen = user.lastSeenAt ? new Date(user.lastSeenAt).getTime() : 0
  const diffMin = (now - lastSeen) / 60000
  if (diffMin < 5) return 'bg-emerald-500 text-emerald-500 status-dot-pulse'
  if (diffMin < 30) return 'bg-amber-500 text-amber-500'
  return 'border border-muted-foreground/50 bg-transparent'
}

interface UserListItem {
  id: string
  telegramId: string | null
  username: string | null
  email: string | null
  name: string
  login: string | null
  role: string
  isBlocked: boolean
  /**
   * Open review flags — a device this account uses also belongs to a blocked
   * one. A COUNT, because two independent signals matching is a different
   * thing from one, and the operator picking which row to open first should
   * see that without clicking into every marked account.
   */
  openReviewFlags: number
  lastSeenAt: string | null
}

interface UserListResponse {
  items: ReadonlyArray<{
    id: string
    telegramId: string | null
    username: string | null
    email: string | null
    name: string
    login: string | null
    role: string
    language: string
    isBlocked: boolean
    openReviewFlags: number
    createdAt: string
    lastSeenAt: string | null
  }>
  total: number
}

export default function UsersPage() {
  const { t } = useTranslation()
  const { activeTab, setTab: handleTabChange } = useTabSync<UsersTab>(ALLOWED_TABS, 'list')
  const [exporting, setExporting] = useState(false)

  const exportRegistration = async () => {
    setExporting(true)
    try {
      await downloadCsv({
        path: '/admin/users/export/registration.csv',
        filename: 'registration-export.csv',
        params: { limit: 1000 },
      })
      toast.success(t('usersPage.export.registrationSuccess'))
    } catch (err) {
      toast.error(getErrorMessage(err, t('usersPage.export.registrationError')))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle icon={UsersIcon} title={t('usersPage.title')} />
          <p className="text-muted-foreground">
            {t('usersPage.subtitle')}
          </p>
        </div>
        <PermissionGate resource="users" action="export_registration">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void exportRegistration()}
            disabled={exporting}
            data-testid="export-registration-csv"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {t('usersPage.export.registration')}
          </Button>
        </PermissionGate>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="list" className="gap-1.5">
            <UsersIcon className="h-3.5 w-3.5" />
            {t('usersPage.tabs.list')}
          </TabsTrigger>
          <TabsTrigger value="bulk" className="gap-1.5">
            <ListChecks className="h-3.5 w-3.5" />
            {t('usersPage.tabs.bulk')}
          </TabsTrigger>
          {/* Здесь, а не в «Администраторах», где он лежал раньше. Этот список
              закрывает вход КЛИЕНТУ — он проверяется на регистрации через
              Telegram, через веб и через бота, и ни на что в самой панели не
              влияет. Рядом с администраторами его искали те, кому он не нужен,
              и не находили те, кому нужен. */}
          <PermissionGate resource="blocked_identities" action="view">
            <TabsTrigger value="blocked-identities" className="gap-1.5">
              <UserX className="h-3.5 w-3.5" />
              {t('usersPage.tabs.blockedIdentities')}
            </TabsTrigger>
          </PermissionGate>
        </TabsList>

        <TabsContent value="list" className="pt-2">
          <UsersListTab />
        </TabsContent>

        <TabsContent value="blocked-identities" className="pt-2">
          <Suspense
            fallback={
              <div className="space-y-3">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-64 w-full" />
              </div>
            }
          >
            <BlockedIdentitiesTab embedded />
          </Suspense>
        </TabsContent>

        <TabsContent value="bulk" className="pt-2">
          <Suspense
            fallback={
              <div className="space-y-3">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-64 w-full" />
              </div>
            }
          >
            <BulkUsersTab />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  )
}

interface UserListRowProps {
  readonly user: UserListItem
  readonly isSelected: boolean
  readonly onSelect: (id: string) => void
}

const UserListRow = memo(function UserListRow({ user, isSelected, onSelect }: UserListRowProps) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={() => onSelect(user.id)}
      className={cn(
        'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors',
        isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{user.name || user.username || user.login || '—'}</p>
          {user.role !== 'USER' && (
            <span className="shrink-0 text-[10px] text-muted-foreground">{user.role}</span>
          )}
          {user.openReviewFlags > 0 && (
            // Amber and an outline icon, deliberately unlike the solid red dot
            // that means BLOCKED. This mark is a question for an operator, not
            // a verdict on the account, and two markers that look alike would
            // turn "somebody should look at this" into "this person is banned".
            <span
              className="shrink-0 inline-flex items-center gap-0.5 text-amber-500"
              title={t('usersPage.reviewFlagged', { count: user.openReviewFlags })}
              aria-label={t('usersPage.reviewFlagged', { count: user.openReviewFlags })}
            >
              <Flag className="h-3 w-3" aria-hidden="true" />
              {user.openReviewFlags > 1 && (
                <span className="text-[10px] tabular-nums">{user.openReviewFlags}</span>
              )}
            </span>
          )}
          <span className={`shrink-0 inline-block h-2.5 w-2.5 rounded-full ${getUserStatusClass(user)}`} />
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {user.username ? `@${user.username} · ` : ''}
          {user.telegramId ?? user.email ?? user.id}
        </p>
      </div>
    </button>
  )
})

function UsersListTab() {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const [searchParams, setSearchParams] = useSearchParams()
  const initialSearch = searchParams.get('search') ?? ''
  const [searchInput, setSearchInput] = useState(initialSearch)
  const [searchQuery, setSearchQuery] = useState(initialSearch)
  // Seeded from the URL so a filtered view survives a reload and can be
  // pasted to somebody else. Read once: after mount this state is the
  // source of truth and the URL follows it.
  const [filters, setFilters] = useState<UserFilters>(() =>
    filtersFromParams(new URLSearchParams(window.location.search)),
  )
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [showCreateUser, setShowCreateUser] = useState(false)

  const LIST_LIMIT = 100

  // Memoised so the query key is stable across renders that did not change a
  // filter — otherwise every keystroke in the search box would look like a
  // new filter set and refetch twice.
  const filterParams = useMemo(() => filtersToParams(filters), [filters])
  const activeFilterCount = countActiveFilters(filters)

  const {
    data: listData,
    isLoading,
    isFetching,
    isError,
  } = useQuery({
    // The filter object is part of the key, so changing a filter refetches
    // exactly as changing the search term does.
    queryKey: ['admin', 'users', 'list', searchQuery, filterParams],
    queryFn: async ({ signal }): Promise<UserListResponse> => {
      const params: Record<string, string | number> = { limit: LIST_LIMIT, ...filterParams }
      const trimmed = searchQuery.trim()
      if (trimmed) {
        params.search = trimmed
      }
      const res = await api.get('/admin/users', { params, signal })
      return res.data as UserListResponse
    },
    placeholderData: (prev) => prev,
  })

  const displayedUsers: UserListItem[] = useMemo(
    () =>
      (listData?.items ?? []).map((u) => ({
        id: u.id,
        telegramId: u.telegramId,
        username: u.username,
        email: u.email,
        name: u.name,
        login: u.login,
        role: u.role,
        isBlocked: u.isBlocked,
        // Defaulted rather than required, so the list still renders against a
        // panel build that predates the field instead of showing NaN beside
        // every name.
        openReviewFlags: u.openReviewFlags ?? 0,
        lastSeenAt: u.lastSeenAt,
      })),
    [listData?.items],
  )

  const total = listData?.total ?? 0
  const hasMore = total > displayedUsers.length

  /**
   * The list follows the box.
   *
   * ── What this replaces ─────────────────────────────────────────────────
   *
   * The query only moved on SUBMIT, which made two ordinary things awkward.
   * Typing a login showed the previous result until you reached for Enter;
   * and CLEARING the box did nothing at all — the full list came back only
   * after submitting an empty field, which is not an action anybody thinks
   * to perform. Deleting what you searched for now returns to where you
   * started, because the empty box is just another query.
   *
   * Enter still works and still bypasses the wait: the submit handler sets
   * the same state this timer would, so the pending timer becomes a no-op.
   */
  useEffect(() => {
    const handle = window.setTimeout(() => setSearchQuery(searchInput), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [searchInput])

  /**
   * Mirror the live query into the address bar.
   *
   * GUARDED, and that is not a micro-optimisation: `setSearchParams` writes a
   * new location, which react-router uses to rebuild the setter itself. An
   * unguarded write in an effect that depends on the setter is a render loop.
   * Comparing against what the URL already says makes the write happen once
   * per actual change and never on a re-render.
   */
  useEffect(() => {
    const trimmed = searchQuery.trim()
    const next: Record<string, string> = { ...filterParams }
    if (trimmed) next.search = trimmed
    // Compared as a whole rather than key by key: the write has to happen
    // when a filter is REMOVED too, and a per-key check would never notice a
    // key that is no longer there.
    const current = Object.fromEntries(searchParams.entries())
    if (JSON.stringify(current) === JSON.stringify(next)) return
    setSearchParams(next, { replace: true })
  }, [searchQuery, filterParams, searchParams, setSearchParams])

  const handleSearch = (e: React.FormEvent): void => {
    e.preventDefault()
    setSearchQuery(searchInput)
    const trimmed = searchInput.trim()
    if (trimmed) {
      setSearchParams({ search: trimmed }, { replace: true })
    } else {
      setSearchParams({}, { replace: true })
    }
  }

  const handleSelectUser = useCallback((userId: string): void => {
    setSelectedUserId(userId)
  }, [])

  // On phones the two panes can't sit side-by-side, so we drill in: the list
  // is full-width until a user is picked, then the detail takes over with a
  // back affordance. On md+ both panes stay visible exactly as before.
  const showList = !isMobile || !selectedUserId
  const showDetail = !isMobile || Boolean(selectedUserId)

  return (
    <div
      data-glass-card
      className="flex h-[calc(100vh-13rem)] min-h-[24rem] gap-0 overflow-hidden rounded-lg border"
    >
      {/* ── Left panel: search + user list ─────────────────────────── */}
      <div
        className={cn(
          'flex flex-col border-r bg-card',
          isMobile ? 'w-full' : 'w-80 shrink-0',
          showList ? '' : 'hidden',
        )}
      >
        {/* Search header */}
        <div className="space-y-2 p-3">
          <form onSubmit={handleSearch} className="flex gap-2">
            <UsersFilterPanel filters={filters} onChange={setFilters} />
            <Input
              placeholder={t('usersPage.searchPlaceholder')}
              aria-label={t('usersPage.searchHint')}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="h-9 text-sm"
            />
            <Button
              type="submit"
              variant="outline"
              size="icon"
              className="h-9 w-9 shrink-0"
              aria-label={`${t('usersPage.title')}: ${t('adminShell.search')}`}
            >
              <Search className="h-4 w-4" aria-hidden="true" />
            </Button>
          </form>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setShowCreateUser(true)}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> {t('usersPage.createUser')}
          </Button>
        </div>

        {/* User list */}
        <ScrollArea className="flex-1">
          {isLoading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
              <UsersIcon className="h-8 w-8 opacity-30" />
              <p className="px-6 text-center text-xs">{t('usersPage.listError')}</p>
            </div>
          ) : displayedUsers.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
              <UsersIcon className="h-8 w-8 opacity-30" />
              <p className="px-6 text-center text-xs">
                {/* An empty list with filters on is not the same message as an
                    empty install. Saying "no users yet" to somebody who ticked
                    four filters sends them looking for a bug. */}
                {searchQuery.trim() || activeFilterCount > 0
                  ? t('usersPage.noResults')
                  : t('usersPage.listEmpty')}
              </p>
            </div>
          ) : (
            <div className="space-y-0.5 p-2">
              {displayedUsers.map((user) => (
                <UserListRow
                  key={user.id}
                  user={user}
                  isSelected={selectedUserId === user.id}
                  onSelect={handleSelectUser}
                />
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Footer counter */}
        {!isError && displayedUsers.length > 0 && (
          <div className="flex items-center justify-between gap-2 border-t bg-card px-3 py-2 text-[11px] text-muted-foreground">
            <span>
              {hasMore
                ? t('usersPage.listFooter', { shown: displayedUsers.length, total })
                : t('usersPage.listFooterAll', { total })}
            </span>
            {isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
          </div>
        )}
      </div>

      {/* ── Right panel: user detail + actions ─────────────────────── */}
      <div
        className={cn(
          'flex-1 overflow-auto bg-background scrollbar-none',
          showDetail ? '' : 'hidden',
        )}
      >
        {selectedUserId ? (
          <FadeIn key={selectedUserId}>
            {isMobile && (
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/80 px-3 py-2 backdrop-blur">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setSelectedUserId(null)}
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  {t('usersPage.backToList')}
                </Button>
              </div>
            )}
            <Suspense fallback={<div className="p-6 space-y-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>}>
              <UserDetailPanel telegramId={selectedUserId} />
            </Suspense>
          </FadeIn>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <UsersIcon className="h-12 w-12 opacity-20" />
            <p className="text-sm">{t('usersPage.selectUser')}</p>
          </div>
        )}
      </div>

      {/* Create User Dialog */}
      <CreateUserDialog
        open={showCreateUser}
        onOpenChange={setShowCreateUser}
        onCreated={(createdId) => {
          setSelectedUserId(createdId)
        }}
      />
    </div>
  )
}

// ── Create User Dialog ────────────────────────────────────────────────────────

function CreateUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: (telegramId: string) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const schema = z
    .object({
      telegramId: z
        .string()
        .trim()
        .refine((v) => v === '' || /^\d+$/.test(v), {
          message: t('usersPage.create.validation.telegramIdInvalid'),
        }),
      username: z.string().trim(),
      name: z.string().trim(),
      email: z
        .string()
        .trim()
        .refine((v) => v === '' || z.string().email().safeParse(v).success, {
          message: t('usersPage.create.validation.emailInvalid'),
        }),
    })
    .refine(
      (data) => Boolean(data.telegramId) || Boolean(data.username) || Boolean(data.name),
      {
        message: t('usersPage.create.validation.atLeastOne'),
        path: ['telegramId'],
      },
    )

  type FormValues = z.infer<typeof schema>

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { telegramId: '', username: '', name: '', email: '' },
  })

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      api.post<{ id?: string; telegramId?: string }>('/admin/users', {
        telegramId: values.telegramId || undefined,
        username: values.username || undefined,
        name: values.name || undefined,
        email: values.email || undefined,
      }),
    onSuccess: (res, values) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      toast.success(t('usersPage.create.success'))
      const createdId = res.data?.id ?? res.data?.telegramId ?? values.telegramId
      onCreated(createdId)
      onOpenChange(false)
      form.reset()
    },
    onError: (err) =>
      toast.error(getErrorMessage(err, t('usersPage.create.error'))),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('usersPage.createUser')}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
            className="space-y-3"
          >
            <FormField
              control={form.control}
              name="telegramId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {t('usersPage.create.telegramId')}{' '}
                    <span className="text-xs text-muted-foreground">
                      ({t('usersPage.create.optional')})
                    </span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="123456789" inputMode="numeric" {...field} />
                  </FormControl>
                  <FormDescription className="text-[11px]">
                    {t('usersPage.create.telegramHint')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('usersPage.create.username')}</FormLabel>
                  <FormControl>
                    <Input placeholder={t('usersPage.create.usernamePlaceholder')} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('usersPage.create.name')}</FormLabel>
                  <FormControl>
                    <Input placeholder={t('usersPage.create.namePlaceholder')} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('usersPage.create.email')}</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      placeholder={t('usersPage.create.emailPlaceholder')}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="mr-2 h-4 w-4" />
                )}
                {t('usersPage.create.submit')}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
