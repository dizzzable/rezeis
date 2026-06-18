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

import { lazy, memo, Suspense, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Search, Users as UsersIcon, Plus, Loader2, ListChecks } from 'lucide-react'

import { api } from '@/lib/api'
import { toast } from 'sonner'
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
import { withFeatureBundle } from '@/i18n/i18n'

const UserDetailPanel = lazy(
  withFeatureBundle('userDetail', () => import('./user-detail-panel')),
)

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
  const { activeTab, setTab: handleTabChange } = useTabSync<UsersTab>(ALLOWED_TABS, 'list')

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

interface UserListRowProps {
  readonly user: UserListItem
  readonly isSelected: boolean
  readonly onSelect: (id: string) => void
}

const UserListRow = memo(function UserListRow({ user, isSelected, onSelect }: UserListRowProps) {
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
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{user.name || '—'}</p>
          {user.role !== 'USER' && (
            <span className="shrink-0 text-[10px] text-muted-foreground">{user.role}</span>
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
    queryFn: async ({ signal }): Promise<UserListResponse> => {
      const params: Record<string, string | number> = { limit: LIST_LIMIT }
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
        role: u.role,
        isBlocked: u.isBlocked,
      })),
    [listData?.items],
  )

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

  const handleSelectUser = useCallback((userId: string): void => {
    setSelectedUserId(userId)
  }, [])

  return (
    <div data-glass-card className="flex h-[calc(100vh-13rem)] gap-0 overflow-hidden rounded-lg border">
      {/* ── Left panel: search + user list ─────────────────────────── */}
      <div className="flex w-80 shrink-0 flex-col border-r bg-card">
        {/* Search header */}
        <div className="space-y-2 p-3">
          <form onSubmit={handleSearch} className="flex gap-2">
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
                {searchQuery.trim()
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
      <div className="flex-1 overflow-auto bg-background scrollbar-none">
        {selectedUserId ? (
          <FadeIn key={selectedUserId}>
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
