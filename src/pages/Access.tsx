import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Shield,
  Plus,
  Search,
  Trash2,
  MoreHorizontal,
  AlertTriangle,
  UserX,
  Crown,
  User,
  Loader2,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Label } from '@/components/ui/label';
import { accessService } from '@/api/access.service';
import type { Admin, AdminRole } from '@/types/entity.types';
import { useAuth } from '@/stores/auth.store';

/**
 * Access Management Page
 * Manage administrators and their roles
 */
export default function Access(): React.ReactElement {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [adminToDelete, setAdminToDelete] = useState<Admin | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [newAdminTelegramId, setNewAdminTelegramId] = useState('');
  const [newAdminRole, setNewAdminRole] = useState<AdminRole>('admin');
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Check if current user is super_admin
  const isSuperAdmin = user?.role === 'super_admin';

  // Fetch admins
  const {
    data: adminsData,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['admins', searchQuery],
    queryFn: () =>
      accessService.getAdmins({
        search: searchQuery || undefined,
        limit: 100,
      }),
    enabled: isSuperAdmin,
  });

  // Add admin mutation
  const addAdminMutation = useMutation({
    mutationFn: accessService.addAdmin,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admins'] });
      setIsAddDialogOpen(false);
      setNewAdminTelegramId('');
      setNewAdminRole('admin');
      setNotification({ type: 'success', message: 'Administrator added successfully' });
      setTimeout(() => setNotification(null), 3000);
    },
    onError: (err: Error) => {
      setNotification({ type: 'error', message: err.message || 'Failed to add administrator' });
      setTimeout(() => setNotification(null), 3000);
    },
  });

  // Delete admin mutation
  const deleteAdminMutation = useMutation({
    mutationFn: accessService.removeAdmin,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admins'] });
      setIsDeleteDialogOpen(false);
      setAdminToDelete(null);
      setNotification({ type: 'success', message: 'Administrator removed successfully' });
      setTimeout(() => setNotification(null), 3000);
    },
    onError: (err: Error) => {
      setNotification({ type: 'error', message: err.message || 'Failed to remove administrator' });
      setTimeout(() => setNotification(null), 3000);
    },
  });

  // Update role mutation
  const updateRoleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: AdminRole }) =>
      accessService.updateRole(id, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admins'] });
      setNotification({ type: 'success', message: 'Role updated successfully' });
      setTimeout(() => setNotification(null), 3000);
    },
    onError: (err: Error) => {
      setNotification({ type: 'error', message: err.message || 'Failed to update role' });
      setTimeout(() => setNotification(null), 3000);
    },
  });

  // Handle add admin
  const handleAddAdmin = () => {
    if (!newAdminTelegramId.trim()) {
      setNotification({ type: 'error', message: 'Telegram ID is required' });
      setTimeout(() => setNotification(null), 3000);
      return;
    }

    addAdminMutation.mutate({
      telegramId: newAdminTelegramId.trim(),
      role: newAdminRole,
      isActive: true,
    });
  };

  // Handle delete admin
  const handleDeleteAdmin = () => {
    if (adminToDelete) {
      deleteAdminMutation.mutate(adminToDelete.id);
    }
  };

  // Handle role change
  const handleRoleChange = (admin: Admin, newRole: AdminRole) => {
    if (admin.role === newRole) return;

    updateRoleMutation.mutate({
      id: admin.id,
      role: newRole,
    });
  };

  // Open delete dialog
  const openDeleteDialog = (admin: Admin) => {
    setAdminToDelete(admin);
    setIsDeleteDialogOpen(true);
  };

  // Get role badge
  const getRoleBadge = (role: AdminRole) => {
    if (role === 'super_admin') {
      return (
        <Badge className="bg-amber-500 hover:bg-amber-600">
          <Crown className="mr-1 h-3 w-3" />
          Super Admin
        </Badge>
      );
    }
    return (
      <Badge variant="secondary">
        <User className="mr-1 h-3 w-3" />
        Admin
      </Badge>
    );
  };

  // If not super_admin, show access denied
  if (!isSuperAdmin) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Access Management</h1>
          <p className="text-muted-foreground mt-1">Manage administrators and their roles</p>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <UserX className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold">Access Denied</h3>
            <p className="text-sm text-muted-foreground mt-2">
              Only Super Administrators can access this page
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Notification */}
      {notification && (
        <div
          className={`fixed top-4 right-4 z-50 flex items-center gap-2 rounded-md px-4 py-3 shadow-lg ${
            notification.type === 'success'
              ? 'bg-green-500 text-white'
              : 'bg-red-500 text-white'
          }`}
        >
          {notification.type === 'success' ? (
            <CheckCircle2 className="h-5 w-5" />
          ) : (
            <XCircle className="h-5 w-5" />
          )}
          <span>{notification.message}</span>
        </div>
      )}

      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Access Management</h1>
          <p className="text-muted-foreground mt-1">Manage administrators and their roles</p>
        </div>
        <Button onClick={() => setIsAddDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
          Add Administrator
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Admins</CardTitle>
            <Shield className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{adminsData?.total || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Super Admins</CardTitle>
            <Crown className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {adminsData?.data.filter((a) => a.role === 'super_admin').length || 0}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Regular Admins</CardTitle>
            <User className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {adminsData?.data.filter((a) => a.role === 'admin').length || 0}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search by telegram ID, username, or name..."
            className="pl-8"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Admins Table */}
      <Card>
        <CardHeader>
          <CardTitle>Administrators</CardTitle>
          <CardDescription>A list of all administrators in the system</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <div className="text-center py-12 text-muted-foreground">
              <AlertTriangle className="mx-auto h-12 w-12 mb-4" />
              <p>Failed to load administrators</p>
              <p className="text-sm">{(error as Error)?.message}</p>
            </div>
          ) : adminsData?.data.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Shield className="mx-auto h-12 w-12 opacity-50 mb-4" />
              <p>No administrators found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Telegram ID</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {adminsData?.data.map((admin) => (
                  <TableRow key={admin.id}>
                    <TableCell className="font-mono text-sm">{admin.telegramId}</TableCell>
                    <TableCell>{admin.username || '-'}</TableCell>
                    <TableCell>
                      {admin.firstName || admin.lastName
                        ? `${admin.firstName || ''} ${admin.lastName || ''}`.trim()
                        : '-'}
                    </TableCell>
                    <TableCell>{getRoleBadge(admin.role)}</TableCell>
                    <TableCell>
                      {admin.isActive ? (
                        <Badge variant="default" className="bg-green-500">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Inactive</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(admin.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">Open menu</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Actions</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => handleRoleChange(admin, 'super_admin')}
                            disabled={admin.role === 'super_admin' || updateRoleMutation.isPending}
                          >
                            <Crown className="mr-2 h-4 w-4" />
                            Make Super Admin
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleRoleChange(admin, 'admin')}
                            disabled={admin.role === 'admin' || updateRoleMutation.isPending}
                          >
                            <User className="mr-2 h-4 w-4" />
                            Make Admin
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => openDeleteDialog(admin)}
                            disabled={deleteAdminMutation.isPending}
                            className="text-red-600"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add Admin Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Administrator</DialogTitle>
            <DialogDescription>
              Add a new administrator by their Telegram ID. The user must have a Telegram account.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="telegramId">Telegram ID</Label>
              <Input
                id="telegramId"
                placeholder="Enter Telegram ID"
                value={newAdminTelegramId}
                onChange={(e) => setNewAdminTelegramId(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The Telegram ID can be found using @userinfobot or similar bots
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="role">Role</Label>
              <select
                id="role"
                value={newAdminRole}
                onChange={(e) => setNewAdminRole(e.target.value as AdminRole)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="admin">Admin</option>
                <option value="super_admin">Super Admin</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAddAdmin}
              disabled={addAdminMutation.isPending || !newAdminTelegramId.trim()}
            >
              {addAdminMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Add Administrator
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Administrator</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove{' '}
              <strong>{adminToDelete?.username || adminToDelete?.telegramId}</strong>? This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleDeleteAdmin}
              disabled={deleteAdminMutation.isPending}
              variant="destructive"
            >
              {deleteAdminMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
