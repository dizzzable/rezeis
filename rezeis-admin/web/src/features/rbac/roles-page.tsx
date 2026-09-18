/**
 * RBAC roles management page.
 *
 * The page is intentionally focused: it lists every role with quick-glance
 * permission/admin counts and lets the operator drill into the matrix
 * editor on the right. System roles are listed but their permission
 * matrix is read-only — only display name + description can be edited.
 *
 * It is written for an owner who has just installed the panel and has never
 * seen `rbac_roles:edit`: every section, action and dangerous permission in
 * the matrix is named and explained (`permission-matrix.tsx`), every button
 * says on hover what pressing it does — or why it cannot be pressed — and a
 * refusal from the server is told in the operator's language (`role-errors.ts`)
 * instead of as "Request failed with status code 403".
 */
import { use, useId, useMemo, useState } from 'react';
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
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonTip } from '@/components/ui/button-tip';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { LabelWithInfo } from '@/components/ui/info-tip';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import type { i18n as I18nInstance } from 'i18next';
import { coreDictionaryReady, loadFeatureBundle } from '@/i18n/i18n';
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
import { PermissionMatrix } from './permission-matrix';
import { permissionLabel } from './permission-labels';
import { translateRoleError } from './role-errors';
import {
  descriptionToStore,
  isReservedRoleName,
  nameToStore,
  roleDescription,
  roleDisplayName,
} from './system-roles';

const ROLES_KEY = ['admin', 'rbac', 'roles'] as const;
const RESOURCES_KEY = ['admin', 'rbac', 'resources'] as const;

/** The server's rule for a role's identifier (`CreateAdminRoleDto.name`). */
const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const ROLE_NAME_MIN = 2;
const ROLE_NAME_MAX = 32;
const DISPLAY_NAME_MIN = 2;

function toPermissions(tokens: Iterable<string>): RbacPermission[] {
  return Array.from(tokens).map((token) => {
    const [resource, action] = token.split(':') as [string, RbacAction];
    return { resource, action };
  });
}

/** Whether the ACTING admin may call one of this page's routes. */
function useCanManageRoles(action: RbacAction): boolean {
  return usePermissionStore((s) => s.hasPermission('rbac_roles', action));
}

/**
 * One promise per language: this page's feature bundle AND the core dictionary.
 *
 * Cached so `use()` is handed the same promise on every render of the same
 * language, and evicted on failure so the next render retries. A failure is
 * survivable — the words fall back to the other language, and the role names
 * to what is stored — so it is logged rather than thrown into the page.
 */
const wordsByLanguage = new Map<string, Promise<void>>();

function wordsReady(language: string): Promise<void> {
  const cached = wordsByLanguage.get(language);
  if (cached !== undefined) return cached;
  const ready = Promise.all([coreDictionaryReady(language), loadFeatureBundle('rbac')])
    .then(() => undefined)
    .catch((error: unknown) => {
      wordsByLanguage.delete(language);
      console.warn(`[i18n] the roles page words for "${language}" did not load:`, error);
    });
  wordsByLanguage.set(language, ready);
  return ready;
}

/**
 * Whether both dictionaries of `language` are already in the store — read
 * without falling back, which is exactly what `t()` would do and must not.
 */
function wordsPresent(store: I18nInstance, language: string): boolean {
  return (
    store.getResource(language, 'translation', 'rolesPage.title') !== undefined &&
    store.getResource(language, 'translation', 'rolesPage.systemRoles.superadmin.name') !== undefined
  );
}

/**
 * Suspends until the page's words exist in the CURRENT language.
 *
 * On a language switch `languageChanged` fires before either dictionary has
 * arrived, so the first render after it would print key paths — and prefill
 * nothing sensible. Suspending hands that render to the enclosing `<Suspense>`
 * instead, which keeps what is on screen, and every edit in it, until the words
 * are in; React preserves the state of a subtree that re-suspends.
 *
 * Only while they are missing: `use()` suspends once even on a promise that
 * has already resolved, and a page whose words are in the store has no reason
 * to flash its fallback on every mount.
 */
function useRolesWords(): void {
  const { i18n: store } = useTranslation();
  if (wordsPresent(store, store.language)) return;
  use(wordsReady(store.language));
}

interface RolesPageProps {
  /**
   * When `true`, hides the page-level header (title + subtitle + sync
   * button position) so the page can be embedded inside a tab without
   * duplicating headings. The sync + create-role buttons move into the
   * grid header instead, next to a short explanation of what a role is.
   */
  readonly embedded?: boolean;
}

export default function RolesPage({ embedded = false }: RolesPageProps = {}) {
  useRolesWords();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const refreshPermissions = usePermissionStore((s) => s.refreshPermissions);
  const permissionsLoaded = usePermissionStore((s) => s.loaded);
  const canView = useCanManageRoles('view');
  const canSync = useCanManageRoles('edit');
  // An admin whose role cannot read roles is told so instead of being sent
  // requests that are refused — the refusal used to land in the empty-list
  // branch and read «Ролей пока нет», which is not what happened. Until the
  // permissions have loaded the page asks anyway, and a refusal is reported.
  const refused = permissionsLoaded && !canView;

  const rolesQuery = useQuery({
    queryKey: ROLES_KEY,
    queryFn: listRoles,
    enabled: !refused,
  });
  const resourcesQuery = useQuery({
    queryKey: RESOURCES_KEY,
    queryFn: getResourceCatalog,
    staleTime: 5 * 60 * 1000,
    enabled: !refused,
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
    enabled: selectedRoleId !== null && !refused,
  });

  const syncMutation = useMutation({
    mutationFn: syncSystemRoles,
    onSuccess: () => {
      toast.success(t('rolesPage.syncSuccess'));
      queryClient.invalidateQueries({ queryKey: ROLES_KEY });
      refreshPermissions().catch(() => undefined);
    },
    onError: (err) => toast.error(t('rolesPage.syncFailed', { message: translateRoleError(t, err) })),
  });

  if (refused) {
    return (
      <Alert data-roles-refused>
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{t('rolesPage.accessDeniedTitle')}</AlertTitle>
        <AlertDescription>
          {t('rolesPage.accessDenied', { permission: permissionLabel(t, 'rbac_roles', 'view') })}
        </AlertDescription>
      </Alert>
    );
  }

  const syncDisabled = syncMutation.isPending || !canSync;

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        {embedded ? (
          <p className="max-w-3xl text-sm text-muted-foreground">{t('rolesPage.intro')}</p>
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
          <ButtonTip
            disabled={syncDisabled}
            tip={
              canSync
                ? t('rolesPage.syncTip')
                : t('rolesPage.noPermission', { permission: permissionLabel(t, 'rbac_roles', 'edit') })
            }
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncMutation.mutate()}
              disabled={syncDisabled}
            >
              <RefreshCw className={cn('mr-2 h-4 w-4', syncMutation.isPending && 'animate-spin')} />
              {t('rolesPage.syncButton')}
            </Button>
          </ButtonTip>
          <CreateRoleDialog
            catalog={resourcesQuery.data ?? null}
            onCreated={(role) => {
              queryClient.invalidateQueries({ queryKey: ROLES_KEY });
              setSelectedRoleId(role.id);
            }}
          />
        </div>
      </header>

      {rolesQuery.isError ? (
        <Alert variant="destructive" data-roles-load-failed>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('rolesPage.loadFailedTitle')}</AlertTitle>
          <AlertDescription>{translateRoleError(t, rolesQuery.error)}</AlertDescription>
        </Alert>
      ) : (
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
              loading={selectedRoleQuery.isLoading || resourcesQuery.isLoading}
              loadError={selectedRoleQuery.error ?? resourcesQuery.error ?? null}
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
      )}
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
              type="button"
              onClick={() => onSelect(role.id)}
              className={cn(
                'w-full text-left rounded-md px-3 py-2 transition-colors flex items-start justify-between gap-2',
                active ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
              )}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate">{roleDisplayName(t, role)}</span>
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
                  {roleDescription(t, role) ?? '—'}
                </p>
              </div>
              <div className={cn('text-[11px] tabular-nums shrink-0 text-right', active ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
                <div>{t('rolesPage.counts.permissions', { count: role.permissionsCount })}</div>
                <div>{t('rolesPage.counts.admins', { count: role.assignedAdminCount })}</div>
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

/**
 * What the operator has changed in the open role, and nothing else. `null` is
 * "untouched": the field shows the role as it is — translated, in whatever
 * language is current — and saves the role's own stored value.
 *
 * Keyed on the role's identity and revision, never on the language: a switch
 * of language is not a reason to throw an operator's edits away, and the
 * fields that follow the language are exactly the untouched ones, which are
 * computed on every render rather than copied into state.
 */
interface RoleDraft {
  readonly key: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly permissions: ReadonlySet<string> | null;
}

function emptyDraft(key: string): RoleDraft {
  return { key, name: null, description: null, permissions: null };
}

function RoleEditor({
  roleId,
  role,
  loading,
  loadError,
  catalog,
  onDeleted,
  onUpdated,
}: {
  roleId: string;
  role: RbacRole | null;
  loading: boolean;
  loadError: unknown;
  catalog: RbacResourceCatalog | null;
  onDeleted: () => void;
  onUpdated: () => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const canEdit = useCanManageRoles('edit');
  const canDelete = useCanManageRoles('delete');

  const roleKey = role ? `${role.id}|${role.updatedAt}` : '';
  const [storedDraft, setDraft] = useState<RoleDraft>(() => emptyDraft(roleKey));
  // A draft left over from another role — or from before this one was saved —
  // reads as untouched. Derived, not reset in render: the rest of this render
  // must see the same draft the next one will.
  const draft = storedDraft.key === roleKey ? storedDraft : emptyDraft(roleKey);

  const storedPermissions = useMemo(
    () => new Set(role ? role.permissions.map((p) => `${p.resource}:${p.action}`) : []),
    [role],
  );

  const saveMutation = useMutation({
    mutationFn: ({ current, edits }: { current: RbacRole; edits: RoleDraft }) =>
      updateRole(current.id, {
        displayName: nameToStore(t, current, edits.name),
        description: descriptionToStore(t, current, edits.description),
        // A system role's permissions are not the editor's to send: the server
        // ignores them for a system role (`RbacService.updateRole`), but it
        // CHECKS them against the acting admin first — so re-sending the role's
        // own permissions stopped anyone who lacked one of them from even
        // renaming it.
        permissions: current.isSystem
          ? []
          : toPermissions(edits.permissions ?? new Set(current.permissions.map((p) => `${p.resource}:${p.action}`))),
      }),
    onSuccess: () => {
      toast.success(t('rolesPage.toasts.roleUpdated'));
      onUpdated();
    },
    onError: (err) => toast.error(t('rolesPage.toasts.updateFailed', { message: translateRoleError(t, err) })),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteRole(roleId),
    onSuccess: () => {
      toast.success(t('rolesPage.toasts.roleDeleted'));
      onDeleted();
    },
    onError: (err) => toast.error(t('rolesPage.toasts.deleteFailed', { message: translateRoleError(t, err) })),
  });

  if (loadError !== null && loadError !== undefined) {
    return (
      <Alert variant="destructive" data-role-load-failed>
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{t('rolesPage.roleLoadFailedTitle')}</AlertTitle>
        <AlertDescription>{translateRoleError(t, loadError)}</AlertDescription>
      </Alert>
    );
  }

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

  const shownName = roleDisplayName(t, role);
  const nameValue = draft.name ?? shownName;
  const descriptionValue = draft.description ?? roleDescription(t, role) ?? '';
  const permissions = draft.permissions ?? storedPermissions;
  const nameTooShort = nameValue.trim().length < DISPLAY_NAME_MIN;
  const saveDisabled = saveMutation.isPending || !canEdit || nameTooShort;
  const saveTip = !canEdit
    ? t('rolesPage.noPermission', { permission: permissionLabel(t, 'rbac_roles', 'edit') })
    : nameTooShort
      ? t('rolesPage.nameTooShort')
      : role.isSystem
        ? t('rolesPage.editor.saveTipSystem')
        : t('rolesPage.editor.saveTip');
  const deleteDisabled = deleteMutation.isPending || !canDelete || role.assignedAdminCount > 0;
  const deleteTip = !canDelete
    ? t('rolesPage.noPermission', { permission: permissionLabel(t, 'rbac_roles', 'delete') })
    : role.assignedAdminCount > 0
      ? t('rolesPage.editor.deleteAssigned', { count: role.assignedAdminCount })
      : t('rolesPage.editor.deleteTip');

  return (
    <Card>
      <CardHeader className="space-y-1.5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            <CardTitle>{shownName}</CardTitle>
            {role.isSystem && <Badge variant="outline">{t('rolesPage.editor.systemRole')}</Badge>}
          </div>
          <div className="flex items-center gap-2">
            <ButtonTip disabled={saveDisabled} tip={saveTip}>
              <Button
                size="sm"
                onClick={() => saveMutation.mutate({ current: role, edits: draft })}
                disabled={saveDisabled}
              >
                {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('rolesPage.editor.save')}
              </Button>
            </ButtonTip>
            {!role.isSystem && (
              <AlertDialog>
                <ButtonTip disabled={deleteDisabled} tip={deleteTip}>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={deleteDisabled}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t('rolesPage.editor.delete')}
                    </Button>
                  </AlertDialogTrigger>
                </ButtonTip>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t('rolesPage.editor.delete')}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('rolesPage.editor.deleteConfirm', { name: shownName })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={deleteMutation.isPending}>
                      {t('common.cancel')}
                    </AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      disabled={deleteMutation.isPending}
                      onClick={() => deleteMutation.mutate()}
                    >
                      {t('rolesPage.editor.delete')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>
        <CardDescription>
          {[
            t('rolesPage.editor.identifier', { name: role.name }),
            t('rolesPage.counts.admins', { count: role.assignedAdminCount }),
            t('rolesPage.counts.permissions', { count: role.permissions.length }),
          ].join(' · ')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <LabelWithInfo
              htmlFor={`${fieldId}-name`}
              info={t('rolesPage.editor.displayNameInfo')}
              infoLabel={t('rolesPage.moreAbout', { name: t('rolesPage.editor.displayName') })}
            >
              {t('rolesPage.editor.displayName')}
            </LabelWithInfo>
            <Input
              id={`${fieldId}-name`}
              value={nameValue}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={64}
            />
          </div>
          <div className="space-y-2">
            <LabelWithInfo
              htmlFor={`${fieldId}-description`}
              info={t('rolesPage.editor.descriptionInfo')}
              infoLabel={t('rolesPage.moreAbout', { name: t('rolesPage.editor.description') })}
            >
              {t('rolesPage.editor.description')}
            </LabelWithInfo>
            <Input
              id={`${fieldId}-description`}
              value={descriptionValue}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
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
          onChange={(next) => setDraft({ ...draft, permissions: next })}
          readOnly={role.isSystem}
          systemPermissions={role.isSystem ? storedPermissions : null}
        />
      </CardContent>
    </Card>
  );
}

// ── Create dialog ─────────────────────────────────────────────────────────

type NameProblem = 'empty' | 'short' | 'pattern' | 'reserved' | null;

/** What is wrong with a typed identifier, checked by the server's own rules. */
function roleNameProblem(name: string): NameProblem {
  if (name === '') return 'empty';
  if (!ROLE_NAME_PATTERN.test(name)) return 'pattern';
  if (name.length < ROLE_NAME_MIN) return 'short';
  if (isReservedRoleName(name)) return 'reserved';
  return null;
}

function CreateRoleDialog({
  catalog,
  onCreated,
}: {
  catalog: RbacResourceCatalog | null;
  onCreated: (role: RbacRole) => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const canCreate = useCanManageRoles('create');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [permissions, setPermissions] = useState<Set<string>>(new Set());

  const mutation = useMutation({
    mutationFn: () =>
      createRole({
        name,
        displayName: displayName.trim(),
        description: description.trim() === '' ? null : description.trim(),
        permissions: toPermissions(permissions),
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
    onError: (err) => toast.error(t('rolesPage.toasts.createFailed', { message: translateRoleError(t, err) })),
  });

  const nameProblem = roleNameProblem(name);
  const nameError =
    nameProblem === 'pattern'
      ? t('rolesPage.createDialog.stableNameInvalid')
      : nameProblem === 'reserved'
        ? t('rolesPage.createDialog.stableNameReserved')
        : null;
  const displayNameTooShort = displayName.trim().length < DISPLAY_NAME_MIN;
  const createDisabled = mutation.isPending || nameProblem !== null || displayNameTooShort;
  const createTip =
    nameProblem !== null
      ? t('rolesPage.createDialog.createNeedsIdentifier')
      : displayNameTooShort
        ? t('rolesPage.nameTooShort')
        : t('rolesPage.createDialog.createTip');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <ButtonTip
        disabled={!canCreate}
        tip={
          canCreate
            ? t('rolesPage.newRoleTip')
            : t('rolesPage.noPermission', { permission: permissionLabel(t, 'rbac_roles', 'create') })
        }
      >
        <DialogTrigger asChild>
          <Button size="sm" disabled={!canCreate}>
            <Plus className="mr-2 h-4 w-4" />
            {t('rolesPage.newRole')}
          </Button>
        </DialogTrigger>
      </ButtonTip>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('rolesPage.createDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('rolesPage.createDialog.dialogDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-identifier`}>
                {t('rolesPage.createDialog.stableName')} <span className="text-destructive">*</span>
              </Label>
              <Input
                id={`${fieldId}-identifier`}
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                placeholder={t('rolesPage.createDialog.stableNamePlaceholder')}
                maxLength={ROLE_NAME_MAX}
                aria-invalid={nameError !== null}
                aria-describedby={`${fieldId}-identifier-hint`}
              />
              <p id={`${fieldId}-identifier-hint`} className="text-xs text-muted-foreground">
                {t('rolesPage.createDialog.stableNameHint')}
              </p>
              {nameError !== null && (
                <p role="alert" className="text-xs text-destructive">
                  {nameError}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-display-name`}>
                {t('rolesPage.createDialog.displayName')} <span className="text-destructive">*</span>
              </Label>
              <Input
                id={`${fieldId}-display-name`}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t('rolesPage.createDialog.displayNamePlaceholder')}
                maxLength={64}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-description`}>{t('rolesPage.createDialog.description')}</Label>
            <Textarea
              id={`${fieldId}-description`}
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
          <ButtonTip disabled={createDisabled} tip={createTip}>
            <Button
              onClick={() => mutation.mutate()}
              disabled={createDisabled}
            >
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <CheckCircle2 className="mr-2 h-4 w-4" />
              {t('rolesPage.createDialog.create')}
            </Button>
          </ButtonTip>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
