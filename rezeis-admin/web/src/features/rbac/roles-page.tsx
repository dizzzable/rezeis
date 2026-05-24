/**
 * RBAC roles management page.
 *
 * The page is intentionally focused: it lists every role with quick-glance
 * permission/admin counts and lets the operator drill into the matrix
 * editor on the right. System roles are listed but their permission
 * matrix is read-only — only display name + description can be edited.
 *
 * The matrix editor groups resources by domain (mirroring `RBAC_RESOURCES`
 * on the backend) and renders a checkbox per (resource × action). All
 * mutations route through React Query with optimistic invalidation so
 * the list refreshes after a save without a manual refetch.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  createRole,
  deleteRole,
  getResourceCatalog,
  getRole,
  listRoles,
  syncSystemRoles,
  updateRole,
  usePermissionStore,
  type RbacAction,
  type RbacPermission,
  type RbacResourceCatalog,
  type RbacRole,
  type RbacRoleListItem,
} from '@/features/rbac';

const ROLES_KEY = ['admin', 'rbac', 'roles'] as const;
const RESOURCES_KEY = ['admin', 'rbac', 'resources'] as const;

interface RolesPageProps {
  /**
   * When `true`, hides the page-level header (title + subtitle + sync
   * button position) so the page can be embedded inside a tab without
   * duplicating headings. The sync + create-role buttons move into the
   * grid header instead.
   */
  readonly embedded?: boolean;
}

export default function RolesPage({ embedded = false }: RolesPageProps = {}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const refreshPermissions = usePermissionStore((s) => s.refreshPermissions);

  const rolesQuery = useQuery({
    queryKey: ROLES_KEY,
    queryFn: listRoles,
  });
  const resourcesQuery = useQuery({
    queryKey: RESOURCES_KEY,
    queryFn: getResourceCatalog,
    staleTime: 5 * 60 * 1000,
  });

  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);

  // Auto-select the first role once data is loaded. Uses the
  // "derive in render" pattern to avoid an effect.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [selectInitialized, setSelectInitialized] = useState(false);
  if (!selectInitialized && rolesQuery.data && rolesQuery.data.length > 0) {
    setSelectInitialized(true);
    if (selectedRoleId === null) setSelectedRoleId(rolesQuery.data[0]?.id ?? null);
  }

  const selectedRoleQuery = useQuery({
    queryKey: ['admin', 'rbac', 'role', selectedRoleId],
    queryFn: () => (selectedRoleId ? getRole(selectedRoleId) : Promise.reject(new Error('No role selected'))),
    enabled: selectedRoleId !== null,
  });

  const syncMutation = useMutation({
    mutationFn: syncSystemRoles,
    onSuccess: () => {
      toast.success(t('rolesPage.syncSuccess'));
      queryClient.invalidateQueries({ queryKey: ROLES_KEY });
      refreshPermissions().catch(() => undefined);
    },
    onError: (err) => toast.error(t('rolesPage.syncFailed', { message: (err as Error).message })),
  });

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        {embedded ? (
          <div />
        ) : (
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ShieldCheck className="h-6 w-6" />
              {t('rolesPage.title')}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {t('rolesPage.subtitle')}
            </p>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <RefreshCw className={cn('mr-2 h-4 w-4', syncMutation.isPending && 'animate-spin')} />
            {t('rolesPage.syncButton')}
          </Button>
          <CreateRoleDialog
            catalog={resourcesQuery.data ?? null}
            onCreated={(role) => {
              queryClient.invalidateQueries({ queryKey: ROLES_KEY });
              setSelectedRoleId(role.id);
            }}
          />
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <RoleList
          roles={rolesQuery.data ?? []}
          loading={rolesQuery.isLoading}
          selectedId={selectedRoleId}
          onSelect={setSelectedRoleId}
        />
        {selectedRoleId === null ? (
          <EmptyEditorPlaceholder />
        ) : (
          <RoleEditor
            roleId={selectedRoleId}
            role={selectedRoleQuery.data ?? null}
            loading={selectedRoleQuery.isLoading}
            catalog={resourcesQuery.data ?? null}
            onDeleted={() => {
              setSelectedRoleId(null);
              queryClient.invalidateQueries({ queryKey: ROLES_KEY });
            }}
            onUpdated={() => {
              queryClient.invalidateQueries({ queryKey: ROLES_KEY });
              queryClient.invalidateQueries({ queryKey: ['admin', 'rbac', 'role', selectedRoleId] });
              refreshPermissions().catch(() => undefined);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Role list ──────────────────────────────────────────────────────────────

function RoleList({
  roles,
  loading,
  selectedId,
  onSelect,
}: {
  roles: RbacRoleListItem[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <Card>
        <CardContent className="p-2 space-y-2">
          {Array.from({ length: 4 }).map((_, idx) => (
            <Skeleton key={idx} className="h-14 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }
  if (roles.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          {t('rolesPage.noRoles')}
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-2 space-y-1">
        {roles.map((role) => {
          const active = role.id === selectedId;
          return (
            <button
              key={role.id}
              onClick={() => onSelect(role.id)}
              className={cn(
                'w-full text-left rounded-md px-3 py-2 transition-colors flex items-start justify-between gap-2',
                active ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
              )}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate">{role.displayName}</span>
                  {role.isSystem && (
                    <Badge
                      variant={active ? 'secondary' : 'outline'}
                      className="text-[10px] uppercase"
                    >
                      {t('rolesPage.editor.systemRole')}
                    </Badge>
                  )}
                </div>
                <p className={cn('text-xs truncate mt-0.5', active ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
                  {role.description ?? '—'}
                </p>
              </div>
              <div className={cn('text-[11px] tabular-nums shrink-0', active ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
                <div>{role.permissionsCount} {t('rolesPage.perms')}</div>
                <div>{role.assignedAdminCount} {role.assignedAdminCount === 1 ? t('rolesPage.admins') : t('rolesPage.adminsPlural')}</div>
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}

function EmptyEditorPlaceholder() {
  const { t } = useTranslation();
  return (
    <Card>
      <CardContent className="py-12 text-center text-sm text-muted-foreground">
        {t('rolesPage.selectRole')}
      </CardContent>
    </Card>
  );
}

// ── Role editor ───────────────────────────────────────────────────────────

function RoleEditor({
  roleId,
  role,
  loading,
  catalog,
  onDeleted,
  onUpdated,
}: {
  roleId: string;
  role: RbacRole | null;
  loading: boolean;
  catalog: RbacResourceCatalog | null;
  onDeleted: () => void;
  onUpdated: () => void;
}) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [permissions, setPermissions] = useState<Set<string>>(new Set());

  // Reset local edit state whenever the loaded role changes — using the
  // "store previous prop in state and adjust during render" pattern.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [roleSnapshotKey, setRoleSnapshotKey] = useState<string | null>(null);
  if (role) {
    const nextKey = `${role.id}|${role.updatedAt}`;
    if (nextKey !== roleSnapshotKey) {
      setRoleSnapshotKey(nextKey);
      setDisplayName(role.displayName);
      setDescription(role.description ?? '');
      setPermissions(new Set(role.permissions.map((p) => `${p.resource}:${p.action}`)));
    }
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!role) return Promise.reject(new Error('Role not loaded'));
      const matrix: RbacPermission[] = Array.from(permissions).map((token) => {
        const [resource, action] = token.split(':') as [string, RbacAction];
        return { resource, action };
      });
      return updateRole(role.id, {
        displayName,
        description: description.trim() === '' ? null : description.trim(),
        permissions: role.isSystem ? role.permissions : matrix,
      });
    },
    onSuccess: () => {
      toast.success(t('rolesPage.toasts.roleUpdated'));
      onUpdated();
    },
    onError: (err) => toast.error(t('rolesPage.toasts.updateFailed', { message: (err as Error).message })),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteRole(roleId),
    onSuccess: () => {
      toast.success(t('rolesPage.toasts.roleDeleted'));
      onDeleted();
    },
    onError: (err) => toast.error(t('rolesPage.toasts.deleteFailed', { message: (err as Error).message })),
  });

  if (loading || !role || !catalog) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="space-y-1.5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            <CardTitle>{role.displayName}</CardTitle>
            {role.isSystem && <Badge variant="outline">{t('rolesPage.editor.systemRole')}</Badge>}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('rolesPage.editor.save')}
            </Button>
            {!role.isSystem && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  if (window.confirm(t('rolesPage.editor.deleteConfirm', { name: role.displayName }))) {
                    deleteMutation.mutate();
                  }
                }}
                disabled={deleteMutation.isPending || role.assignedAdminCount > 0}
                title={role.assignedAdminCount > 0 ? t('rolesPage.editor.deleteAssigned') : ''}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t('rolesPage.editor.delete')}
              </Button>
            )}
          </div>
        </div>
        <CardDescription>
          {t('rolesPage.editor.meta', {
            count: role.assignedAdminCount,
            name: role.name,
            adminsCount: role.assignedAdminCount,
            permsCount: role.permissions.length,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>{t('rolesPage.editor.displayName')}</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={64}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('rolesPage.editor.description')}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={256}
              placeholder={t('rolesPage.editor.descriptionPlaceholder')}
            />
          </div>
        </div>

        <Separator />

        {role.isSystem ? (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{t('rolesPage.editor.systemReadOnly')}</AlertTitle>
            <AlertDescription>
              {t('rolesPage.editor.systemReadOnlyDescription')}
            </AlertDescription>
          </Alert>
        ) : null}

        <PermissionMatrix
          catalog={catalog}
          permissions={permissions}
          onChange={setPermissions}
          readOnly={role.isSystem}
          systemPermissions={role.isSystem ? new Set(role.permissions.map((p) => `${p.resource}:${p.action}`)) : null}
        />
      </CardContent>
    </Card>
  );
}

// ── Permission matrix ─────────────────────────────────────────────────────

function PermissionMatrix({
  catalog,
  permissions,
  onChange,
  readOnly,
  systemPermissions,
}: {
  catalog: RbacResourceCatalog;
  permissions: Set<string>;
  onChange: (next: Set<string>) => void;
  readOnly: boolean;
  systemPermissions: Set<string> | null;
}) {
  const { t } = useTranslation();
  const ordered = useMemo(() => Object.entries(catalog.resources), [catalog]);

  function toggle(resource: string, action: RbacAction) {
    if (readOnly) return;
    const token = `${resource}:${action}`;
    const next = new Set(permissions);
    if (next.has(token)) next.delete(token);
    else next.add(token);
    onChange(next);
  }
  function setRow(resource: string, actions: RbacAction[], allOn: boolean) {
    if (readOnly) return;
    const next = new Set(permissions);
    for (const action of actions) {
      const token = `${resource}:${action}`;
      if (allOn) next.add(token);
      else next.delete(token);
    }
    onChange(next);
  }

  const effective = readOnly && systemPermissions ? systemPermissions : permissions;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">{t('rolesPage.editor.permissions')}</h3>
      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{t('rolesPage.editor.resourceColumn')}</th>
              {catalog.actions.map((action) => (
                <th key={action} className="px-2 py-2 text-center font-medium capitalize text-xs">
                  {action.replace(/_/g, ' ')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map(([resource, actions]) => {
              const rowGranted = actions.filter((a) => effective.has(`${resource}:${a}`));
              const allOn = rowGranted.length === actions.length;
              return (
                <tr key={resource} className="border-t">
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <code className="text-xs">{resource}</code>
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={() => setRow(resource, actions, !allOn)}
                          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {allOn ? t('rolesPage.editor.clear') : t('rolesPage.editor.all')}
                        </button>
                      )}
                    </div>
                  </td>
                  {catalog.actions.map((action) => {
                    const supports = (actions as readonly string[]).includes(action);
                    if (!supports) {
                      return (
                        <td key={action} className="px-2 py-2 text-center text-muted-foreground">
                          –
                        </td>
                      );
                    }
                    const checked = effective.has(`${resource}:${action}`);
                    return (
                      <td key={action} className="px-2 py-2 text-center">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggle(resource, action as RbacAction)}
                          disabled={readOnly}
                          aria-label={`${resource}:${action}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Create dialog ─────────────────────────────────────────────────────────

function CreateRoleDialog({
  catalog,
  onCreated,
}: {
  catalog: RbacResourceCatalog | null;
  onCreated: (role: RbacRole) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [permissions, setPermissions] = useState<Set<string>>(new Set());

  const mutation = useMutation({
    mutationFn: () =>
      createRole({
        name,
        displayName,
        description: description.trim() === '' ? null : description.trim(),
        permissions: Array.from(permissions).map((token) => {
          const [resource, action] = token.split(':') as [string, RbacAction];
          return { resource, action };
        }),
      }),
    onSuccess: (role) => {
      toast.success(t('rolesPage.toasts.roleCreated'));
      setOpen(false);
      setName('');
      setDisplayName('');
      setDescription('');
      setPermissions(new Set());
      onCreated(role);
    },
    onError: (err) => toast.error(t('rolesPage.toasts.createFailed', { message: (err as Error).message })),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-2 h-4 w-4" />
          {t('rolesPage.newRole')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('rolesPage.createDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('rolesPage.createDialog.dialogDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>
                {t('rolesPage.createDialog.stableName')} <span className="text-destructive">*</span>
              </Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                placeholder={t('rolesPage.createDialog.stableNamePlaceholder')}
                maxLength={32}
              />
              <p className="text-xs text-muted-foreground">
                {t('rolesPage.createDialog.stableNameHint')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>
                {t('rolesPage.createDialog.displayName')} <span className="text-destructive">*</span>
              </Label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t('rolesPage.createDialog.displayNamePlaceholder')}
                maxLength={64}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t('rolesPage.createDialog.description')}</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={256}
              rows={2}
              placeholder={t('rolesPage.createDialog.descriptionPlaceholder')}
            />
          </div>
          {catalog && (
            <PermissionMatrix
              catalog={catalog}
              permissions={permissions}
              onChange={setPermissions}
              readOnly={false}
              systemPermissions={null}
            />
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t('rolesPage.createDialog.cancel')}
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || name.trim().length < 2 || displayName.trim().length < 2}
          >
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <CheckCircle2 className="mr-2 h-4 w-4" />
            {t('rolesPage.createDialog.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
