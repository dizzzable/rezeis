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

/* eslint-disable @typescript-eslint/no-explicit-any -- TODO: type API responses */

import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, Users as UsersIcon, Plus, Loader2, ListChecks } from 'lucide-react'

import { api } from '@/lib/api'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { FadeIn } from '@/lib/motion'
import UserDetailPanel from './user-detail-panel'

const BulkUsersTab = lazy(() => import('@/features/users/bulk-users-page'))

const ALLOWED_TABS = ['list', 'bulk'] as const
type UsersTab = (typeof ALLOWED_TABS)[number]

function getUserStatusClass(user: { isBlocked: boolean; updatedAt?: string }): string {
  if (user.isBlocked) return 'bg-destructive text-destructive'
  const now = Date.now()
  const updatedAt = user.updatedAt ? new Date(user.updatedAt).getTime() : 0
  const diffMin = (now - updatedAt) / 60000
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
  role: string
  isBlocked: boolean
}

interface UserListResponse {
  items: ReadonlyArray<{
    id: string
    telegramId: string | null
    username: string | null
    email: string | null
    name: string
    role: string
    language: string
    isBlocked: boolean
    createdAt: string
  }>
  total: number
}

export default function UsersPage() {
  const { t } = useTranslation()
  const { hash: locationHash, pathname: locationPathname } = useLocation()
  const navigate = useNavigate()

  const initialTab: UsersTab = (() => {
    const hash = locationHash.replace('#', '')
    return (ALLOWED_TABS as readonly string[]).includes(hash) ? (hash as UsersTab) : 'list'
  })()

  const [activeTab, setActiveTab] = useState<UsersTab>(initialTab)

  useEffect(() => {
    const hash = locationHash.replace('#', '')
    if ((ALLOWED_TABS as readonly string[]).includes(hash) && hash !== activeTab) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO: refactor to derive state
      setActiveTab(hash as UsersTab)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationHash])

  function handleTabChange(value: string): void {
    if (!(ALLOWED_TABS as readonly string[]).includes(value)) return
    setActiveTab(value as UsersTab)
    navigate(`${locationPathname}#${value}`, { replace: true })
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <UsersIcon className="h-6 w-6" />
          {t('usersPage.title')}
        </h1>
        <p className="text-muted-foreground">
          {t('usersPage.subtitle')}
        </p>
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
        </TabsList>

        <TabsContent value="list" className="pt-2">
          <UsersListTab />
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

function UsersListTab() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const initialSearch = searchParams.get('search') ?? ''
  const [searchInput, setSearchInput] = useState(initialSearch)
  const [searchQuery, setSearchQuery] = useState(initialSearch)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [showCreateUser, setShowCreateUser] = useState(false)

  const LIST_LIMIT = 100

  const {
    data: listData,
    isLoading,
    isFetching,
    isError,
  } = useQuery({
    queryKey: ['admin', 'users', 'list', searchQuery],
    queryFn: async (): Promise<UserListResponse> => {
      const params: Record<string, string | number> = { limit: LIST_LIMIT }
      const trimmed = searchQuery.trim()
      if (trimmed) {
        params.search = trimmed
      }
      const res = await api.get('/admin/users', { params })
      return res.data as UserListResponse
    },
    placeholderData: (prev) => prev,
  })

  const displayedUsers: UserListItem[] = (listData?.items ?? []).map((u) => ({
    id: u.id,
    telegramId: u.telegramId,
    username: u.username,
    email: u.email,
    name: u.name,
    role: u.role,
    isBlocked: u.isBlocked,
  }))

  const total = listData?.total ?? 0
  const hasMore = total > displayedUsers.length

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

  const handleSelectUser = (userId: string): void => {
    setSelectedUserId(userId)
  }

  return (
    <div data-glass-card className="flex h-[calc(100vh-13rem)] gap-0 overflow-hidden rounded-lg border">
      {/* ── Left panel: search + user list ─────────────────────────── */}
      <div className="flex w-80 shrink-0 flex-col border-r bg-card">
        {/* Search header */}
        <div className="space-y-2 p-3">
          <form onSubmit={handleSearch} className="flex gap-2">
            <Input
              placeholder={t('usersPage.searchPlaceholder')}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="h-9 text-sm"
            />
            <Button type="submit" variant="outline" size="icon" className="h-9 w-9 shrink-0">
              <Search className="h-4 w-4" />
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
                {searchQuery.trim()
                  ? t('usersPage.noResults')
                  : t('usersPage.listEmpty')}
              </p>
            </div>
          ) : (
            <div className="space-y-0.5 p-2">
              {displayedUsers.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => handleSelectUser(user.id)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors',
                    selectedUserId === user.id
                      ? 'bg-primary/10 text-primary'
                      : 'hover:bg-muted',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{user.name || '—'}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {user.username ? `@${user.username} · ` : ''}
                      {user.telegramId ?? user.email ?? user.id}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${getUserStatusClass(user)}`} />
                    {user.role !== 'USER' && (
                      <span className="text-[10px] text-muted-foreground">{user.role}</span>
                    )}
                  </div>
                </button>
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
      <div className="flex-1 overflow-auto bg-background scrollbar-none">
        {selectedUserId ? (
          <FadeIn key={selectedUserId}>
            <UserDetailPanel telegramId={selectedUserId} />
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
  const [telegramId, setTelegramId] = useState('')
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/admin/users', {
        telegramId,
        username: username || undefined,
        name: name || undefined,
        email: email || undefined,
      }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      toast.success(t('usersPage.create.success'))
      const createdId = res.data?.id || res.data?.telegramId || telegramId
      onCreated(createdId)
      onOpenChange(false)
      setTelegramId('')
      setUsername('')
      setName('')
      setEmail('')
    },
    onError: (err: any) =>
      toast.error(err.response?.data?.message ?? t('usersPage.create.error')),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('usersPage.createUser')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('usersPage.create.telegramId')} <span className="text-xs text-muted-foreground">({t('usersPage.create.optional')})</span></Label>
            <Input
              placeholder="123456789"
              value={telegramId}
              onChange={(e) => setTelegramId(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('usersPage.create.telegramHint')}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>{t('usersPage.create.username')}</Label>
            <Input
              placeholder={t('usersPage.create.usernamePlaceholder')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('usersPage.create.name')}</Label>
            <Input
              placeholder={t('usersPage.create.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('usersPage.create.email')}</Label>
            <Input
              placeholder={t('usersPage.create.emailPlaceholder')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => mutation.mutate()}
              disabled={(!telegramId.trim() && !name.trim() && !username.trim()) || mutation.isPending}
            >
              {mutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              {t('usersPage.create.submit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
