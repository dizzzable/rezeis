import { lazy, Suspense, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, Network, Pencil, Plus, Shield, ShieldBan, ShieldCheck, Trash2, Webhook } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'

import { api } from '@/lib/api'
import { formatDateTime } from '@/lib/utils'
import { useTabSync } from '@/lib/use-tab-sync'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const RolesTab = lazy(() => import('@/features/rbac/roles-page'))
const IpAllowlistTab = lazy(() => import('@/features/two-factor/admin-ip-allowlist-page'))
const WebhooksTab = lazy(() => import('@/features/webhooks/webhooks-page'))
const BlockedIpsTab = lazy(() => import('@/features/blocked-ips/blocked-ips-page'))

const ALLOWED_TABS = ['admins', 'roles', 'ip-allowlist', 'webhooks', 'blocked-ips'] as const
type AdminsTab = (typeof ALLOWED_TABS)[number]

// ─── Types ───────────────────────────────────────────────────────────────────

type AdminRole = 'DEV' | 'ADMIN'
const ROLES: readonly AdminRole[] = ['DEV', 'ADMIN'] as const

interface Admin {
  readonly id: string
  readonly username: string
  readonly name: string | null
  readonly role: AdminRole
  readonly isActive: boolean
  readonly lastLoginAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function roleBadgeVariant(role: AdminRole): 'default' | 'secondary' {
  return role === 'DEV' ? 'default' : 'secondary'
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const adminSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/),
  password: z.string().min(8).max(128),
  role: z.enum(['DEV', 'ADMIN']),
  name: z.string().max(120).optional(),
})
type AdminFormValues = z.infer<typeof adminSchema>

const editAdminSchema = z.object({
  password: z.string().min(8).max(128).optional().or(z.literal('')),
  role: z.enum(['DEV', 'ADMIN']).optional(),
  isActive: z.boolean().optional(),
  name: z.string().max(120).optional(),
})
type EditAdminFormValues = z.infer<typeof editAdminSchema>

// ─── API helpers ─────────────────────────────────────────────────────────────

async function fetchAdmins(): Promise<readonly Admin[]> {
  return (await api.get<readonly Admin[]>('/admin/admins')).data
}

async function createAdmin(data: AdminFormValues): Promise<Admin> {
  return (await api.post<Admin>('/admin/admins', data)).data
}

async function updateAdmin({
  id,
  data,
}: {
  id: string
  data: Partial<EditAdminFormValues>
}): Promise<Admin> {
  return (await api.patch<Admin>(`/admin/admins/${id}`, data)).data
}

async function deleteAdmin(id: string): Promise<void> {
  await api.delete(`/admin/admins/${id}`)
}

// ─── Create Admin Dialog ──────────────────────────────────────────────────────

function CreateAdminDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (o: boolean) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const form = useForm<AdminFormValues>({
    resolver: zodResolver(adminSchema),
    defaultValues: { username: '', password: '', role: 'ADMIN', name: '' },
  })

  const mutation = useMutation({
    mutationFn: createAdmin,
    onSuccess: () => {
      toast.success(t('adminsPage.toast.created'))
      void queryClient.invalidateQueries({ queryKey: ['admins'] })
      onOpenChange(false)
      form.reset({ username: '', password: '', role: 'ADMIN', name: '' })
    },
    onError: (err: unknown) => {
      const message =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast.error(message ?? t('adminsPage.toast.createFailed'))
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('adminsPage.create.title')}</DialogTitle>
          <DialogDescription>{t('adminsPage.create.description')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('adminsPage.fields.username')}</FormLabel>
                  <FormControl>
                    <Input placeholder="admin_user" autoComplete="off" {...field} />
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
                  <FormLabel>{t('adminsPage.fields.displayName')}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t('adminsPage.fields.displayNamePlaceholder')}
                      autoComplete="off"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('adminsPage.fields.password')}</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder={t('adminsPage.fields.passwordPlaceholder')}
                      autoComplete="new-password"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('adminsPage.fields.role')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {t(`adminsPage.roles.${r}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter className="pt-2">
              <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? t('adminsPage.create.submitting') : t('adminsPage.create.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Edit Admin Dialog ────────────────────────────────────────────────────────

function EditAdminDialog({
  open,
  onOpenChange,
  admin,
}: {
  readonly open: boolean
  readonly onOpenChange: (o: boolean) => void
  readonly admin: Admin
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const form = useForm<EditAdminFormValues>({
    resolver: zodResolver(editAdminSchema),
    defaultValues: {
      password: '',
      role: admin.role,
      isActive: admin.isActive,
      name: admin.name ?? '',
    },
  })

  const handleOpenChange = (o: boolean) => {
    if (o) {
      form.reset({
        password: '',
        role: admin.role,
        isActive: admin.isActive,
        name: admin.name ?? '',
      })
    }
    onOpenChange(o)
  }

  const mutation = useMutation({
    mutationFn: (data: Partial<EditAdminFormValues>) => updateAdmin({ id: admin.id, data }),
    onSuccess: () => {
      toast.success(t('adminsPage.toast.updated', { username: admin.username }))
      void queryClient.invalidateQueries({ queryKey: ['admins'] })
      onOpenChange(false)
    },
    onError: (err: unknown) => {
      const message =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast.error(message ?? t('adminsPage.toast.updateFailed'))
    },
  })

  function onSubmit(values: EditAdminFormValues): void {
    const payload: Partial<EditAdminFormValues> = {}
    if (values.password && values.password.length > 0) {
      payload.password = values.password
    }
    if (values.role && values.role !== admin.role) {
      payload.role = values.role
    }
    if (typeof values.isActive === 'boolean' && values.isActive !== admin.isActive) {
      payload.isActive = values.isActive
    }
    if (typeof values.name === 'string' && values.name !== (admin.name ?? '')) {
      payload.name = values.name
    }
    if (Object.keys(payload).length === 0) {
      toast.info(t('adminsPage.toast.noChanges'))
      return
    }
    mutation.mutate(payload)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('adminsPage.edit.title')}</DialogTitle>
          <DialogDescription>
            {t('adminsPage.edit.description', { username: admin.username })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-4 py-3">
          <Avatar className="h-9 w-9">
            <AvatarFallback className="bg-primary text-primary-foreground text-sm font-semibold">
              {admin.username.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate font-medium leading-tight">{admin.username}</p>
            <p className="text-xs text-muted-foreground">ID: {admin.id}</p>
          </div>
          <Badge variant={roleBadgeVariant(admin.role)} className="ml-auto shrink-0">
            {t(`adminsPage.roles.${admin.role}`)}
          </Badge>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('adminsPage.fields.displayName')}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t('adminsPage.fields.displayNamePlaceholder')}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('adminsPage.edit.passwordLabel')}</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder={t('adminsPage.edit.passwordPlaceholder')}
                      autoComplete="new-password"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('adminsPage.fields.role')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {t(`adminsPage.roles.${r}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="isActive"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('adminsPage.fields.status')}</FormLabel>
                  <div className="flex items-center justify-between rounded-lg border px-4 py-3">
                    <div className="space-y-0.5">
                      <Label htmlFor="isActive-switch" className="cursor-pointer font-medium">
                        {field.value
                          ? t('adminsPage.status.active')
                          : t('adminsPage.status.inactive')}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {field.value
                          ? t('adminsPage.status.activeDescription')
                          : t('adminsPage.status.inactiveDescription')}
                      </p>
                    </div>
                    <Switch
                      id="isActive-switch"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="pt-1">
              <Button
                variant="outline"
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={mutation.isPending}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? t('adminsPage.edit.submitting') : t('adminsPage.edit.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminsPage() {
  const { t } = useTranslation()
  const { activeTab, setTab: handleTabChange } = useTabSync<AdminsTab>(ALLOWED_TABS, 'admins')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Shield className="h-6 w-6" /> {t('adminsPage.title')}
        </h1>
        <p className="text-muted-foreground">{t('adminsPage.subtitle')}</p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="admins" className="gap-1.5">
            <Shield className="h-3.5 w-3.5" />
            {t('adminsPage.tabs.admins')}
          </TabsTrigger>
          <TabsTrigger value="roles" className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            {t('adminsPage.tabs.roles')}
          </TabsTrigger>
          <TabsTrigger value="ip-allowlist" className="gap-1.5">
            <Network className="h-3.5 w-3.5" />
            {t('adminsPage.tabs.ipAllowlist')}
          </TabsTrigger>
          <TabsTrigger value="webhooks" className="gap-1.5">
            <Webhook className="h-3.5 w-3.5" />
            {t('adminsPage.tabs.webhooks')}
          </TabsTrigger>
          <TabsTrigger value="blocked-ips" className="gap-1.5">
            <ShieldBan className="h-3.5 w-3.5" />
            {t('adminsPage.tabs.blockedIps')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="admins" className="pt-2">
          <AdminsListTab />
        </TabsContent>

        <TabsContent value="roles" className="pt-2">
          <Suspense
            fallback={
              <div className="space-y-3">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-64 w-full" />
              </div>
            }
          >
            <RolesTab embedded />
          </Suspense>
        </TabsContent>

        <TabsContent value="ip-allowlist" className="pt-2">
          <Suspense
            fallback={
              <div className="space-y-3">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-64 w-full" />
              </div>
            }
          >
            <IpAllowlistTab embedded />
          </Suspense>
        </TabsContent>

        <TabsContent value="webhooks" className="pt-2">
          <Suspense
            fallback={
              <div className="space-y-3">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-64 w-full" />
              </div>
            }
          >
            <WebhooksTab embedded />
          </Suspense>
        </TabsContent>

        <TabsContent value="blocked-ips" className="pt-2">
          <Suspense
            fallback={
              <div className="space-y-3">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-64 w-full" />
              </div>
            }
          >
            <BlockedIpsTab embedded />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function AdminsListTab() {
  const { t } = useTranslation()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingAdmin, setEditingAdmin] = useState<Admin | null>(null)
  const queryClient = useQueryClient()

  const { data, isLoading, error } = useQuery({ queryKey: ['admins'], queryFn: fetchAdmins })

  const deleteMutation = useMutation({
    mutationFn: deleteAdmin,
    onSuccess: () => {
      toast.success(t('adminsPage.toast.deleted'))
      void queryClient.invalidateQueries({ queryKey: ['admins'] })
    },
    onError: (err: unknown) => {
      const message =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast.error(message ?? t('adminsPage.toast.deleteFailed'))
    },
  })

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{t('common.error')}</AlertTitle>
        <AlertDescription>{t('adminsPage.error.body')}</AlertDescription>
      </Alert>
    )
  }

  const admins = data ?? []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t('adminsPage.add')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('adminsPage.tableTitle')}</CardTitle>
          </div>
          <CardDescription>
            {!isLoading && t('adminsPage.count', { count: admins.length })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : admins.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">{t('adminsPage.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('adminsPage.columns.admin')}</TableHead>
                  <TableHead>{t('adminsPage.columns.role')}</TableHead>
                  <TableHead>{t('adminsPage.columns.status')}</TableHead>
                  <TableHead>{t('adminsPage.columns.lastLogin')}</TableHead>
                  <TableHead>{t('adminsPage.columns.created')}</TableHead>
                  <TableHead className="w-[100px]">{t('adminsPage.columns.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {admins.map((admin) => (
                  <TableRow key={admin.id}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <Avatar className="h-7 w-7">
                          <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">
                            {admin.username.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{admin.username}</p>
                          {admin.name ? (
                            <p className="truncate text-xs text-muted-foreground">{admin.name}</p>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={roleBadgeVariant(admin.role)}>
                        {t(`adminsPage.roles.${admin.role}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {admin.isActive ? (
                        <Badge variant="success">{t('adminsPage.status.active')}</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-muted-foreground">
                          {t('adminsPage.status.inactive')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {admin.lastLoginAt ? formatDateTime(admin.lastLoginAt) : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(admin.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => setEditingAdmin(admin)}
                          aria-label={t('adminsPage.actions.edit', { username: admin.username })}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              aria-label={t('adminsPage.actions.delete', {
                                username: admin.username,
                              })}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{t('adminsPage.delete.title')}</AlertDialogTitle>
                              <AlertDialogDescription>
                                {t('adminsPage.delete.description', { username: admin.username })}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => deleteMutation.mutate(admin.id)}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                {t('adminsPage.delete.confirm')}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <CreateAdminDialog open={dialogOpen} onOpenChange={setDialogOpen} />

      {editingAdmin ? (
        <EditAdminDialog
          open={Boolean(editingAdmin)}
          onOpenChange={(o) => {
            if (!o) setEditingAdmin(null)
          }}
          admin={editingAdmin}
        />
      ) : null}
    </div>
  )
}
