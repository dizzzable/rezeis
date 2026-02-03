import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  Users as UsersIcon,
  Search,
  Plus,
  Filter,
  Download,
  Eye,
  Edit,
  Ban,
  CheckCircle,
  MoreHorizontal,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  X,
  UserCheck,
  UserX,
  Trash2,
  Calendar,
  Hash,
  Mail,
  User,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Label } from '@/components/ui/label';
import { usersService } from '@/api/users.service';
import type { User as UserType, CreateUserDTO, UpdateUserDTO } from '@/types/entity.types';
import * as XLSX from 'xlsx';

// Types for sorting and filtering
type SortField = 'id' | 'username' | 'telegramId' | 'role' | 'isActive' | 'createdAt' | 'lastLoginAt';
type SortDirection = 'asc' | 'desc';

interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

interface FilterConfig {
  id: string;
  username: string;
  telegramId: string;
  role: 'all' | 'admin' | 'user';
  isActive: 'all' | 'active' | 'inactive';
  dateFrom: string;
  dateTo: string;
}

const ITEMS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

/**
 * Users page component with advanced features
 * Features: filtering, sorting, pagination, export, detail view, quick actions
 */
export default function Users(): React.ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);

  // Sorting state
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    field: 'createdAt',
    direction: 'desc',
  });

  // Filtering state
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<FilterConfig>({
    id: '',
    username: '',
    telegramId: '',
    role: 'all',
    isActive: 'all',
    dateFrom: '',
    dateTo: '',
  });

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  // Dialog states
  const [selectedUser, setSelectedUser] = useState<UserType | null>(null);
  const [isDetailDialogOpen, setIsDetailDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<UserType | null>(null);
  const [userToBlock, setUserToBlock] = useState<UserType | null>(null);
  const [isBlockDialogOpen, setIsBlockDialogOpen] = useState(false);

  // Form states for create/edit
  const [formData, setFormData] = useState<Partial<CreateUserDTO & UpdateUserDTO>>({
    username: '',
    firstName: '',
    lastName: '',
    telegramId: '',
    role: 'user',
    isActive: true,
  });

  // Fetch users
  const {
    data: usersResponse,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['users', currentPage, itemsPerPage, searchQuery, filters, sortConfig],
    queryFn: () =>
      usersService.getUsers({
        page: currentPage,
        limit: itemsPerPage,
        search: searchQuery || undefined,
        role: filters.role !== 'all' ? filters.role : undefined,
        isActive: filters.isActive !== 'all' ? filters.isActive === 'active' : undefined,
      }),
  });

  const users = usersResponse?.data || [];
  const totalUsers = usersResponse?.total || 0;
  const totalPages = Math.ceil(totalUsers / itemsPerPage);

  // Mutations
  const createUserMutation = useMutation({
    mutationFn: (data: CreateUserDTO) => usersService.createUser(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setIsCreateDialogOpen(false);
      resetForm();
    },
  });

  const updateUserMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateUserDTO }) =>
      usersService.updateUser(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setIsEditDialogOpen(false);
      setSelectedUser(null);
    },
  });

  const deleteUserMutation = useMutation({
    mutationFn: (id: string) => usersService.deleteUser(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setIsDeleteDialogOpen(false);
      setUserToDelete(null);
    },
  });

  const blockUserMutation = useMutation({
    mutationFn: (id: string) => usersService.blockUser(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setIsBlockDialogOpen(false);
      setUserToBlock(null);
    },
  });

  const unblockUserMutation = useMutation({
    mutationFn: (id: string) => usersService.unblockUser(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  // Sorting handler
  const handleSort = (field: SortField) => {
    setSortConfig((current) => ({
      field,
      direction:
        current.field === field && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  // Sort icon helper
  const getSortIcon = (field: SortField) => {
    if (sortConfig.field !== field) {
      return <ArrowUpDown className="ml-2 h-4 w-4 text-muted-foreground" />;
    }
    return sortConfig.direction === 'asc' ? (
      <ArrowUp className="ml-2 h-4 w-4" />
    ) : (
      <ArrowDown className="ml-2 h-4 w-4" />
    );
  };

  // Filter handlers
  const handleFilterChange = (key: keyof FilterConfig, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setCurrentPage(1); // Reset to first page on filter change
  };

  const clearFilters = () => {
    setFilters({
      id: '',
      username: '',
      telegramId: '',
      role: 'all',
      isActive: 'all',
      dateFrom: '',
      dateTo: '',
    });
    setSearchQuery('');
    setCurrentPage(1);
  };

  const hasActiveFilters = useMemo(() => {
    return (
      filters.id ||
      filters.username ||
      filters.telegramId ||
      filters.role !== 'all' ||
      filters.isActive !== 'all' ||
      filters.dateFrom ||
      filters.dateTo ||
      searchQuery
    );
  }, [filters, searchQuery]);

  // Export to Excel
  const handleExportToExcel = () => {
    const exportData = users.map((user) => ({
      ID: user.id,
      Username: user.username,
      'First Name': user.firstName || '-',
      'Last Name': user.lastName || '-',
      'Telegram ID': user.telegramId || '-',
      Role: user.role,
      Status: user.isActive ? 'Active' : 'Inactive',
      'Last Login': user.lastLoginAt
        ? new Date(user.lastLoginAt).toLocaleString()
        : 'Never',
      'Created At': new Date(user.createdAt).toLocaleString(),
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Users');

    // Auto-size columns
    const colWidths = [
      { wch: 10 },
      { wch: 20 },
      { wch: 15 },
      { wch: 15 },
      { wch: 15 },
      { wch: 10 },
      { wch: 10 },
      { wch: 20 },
      { wch: 20 },
    ];
    ws['!cols'] = colWidths;

    const timestamp = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `users-export-${timestamp}.xlsx`);
  };

  // Form handlers
  const resetForm = () => {
    setFormData({
      username: '',
      firstName: '',
      lastName: '',
      telegramId: '',
      role: 'user',
      isActive: true,
    });
  };

  const populateEditForm = (user: UserType) => {
    setFormData({
      username: user.username,
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      telegramId: user.telegramId || '',
      role: user.role,
      isActive: user.isActive,
    });
  };

  const handleCreateUser = () => {
    if (!formData.username) return;
    createUserMutation.mutate(formData as CreateUserDTO);
  };

  const handleUpdateUser = () => {
    if (!selectedUser || !formData.username) return;
    updateUserMutation.mutate({
      id: selectedUser.id,
      data: formData as UpdateUserDTO,
    });
  };

  // Action handlers
  const handleViewDetails = (user: UserType) => {
    navigate(`/users/${user.id}`);
  };

  const handleEditClick = (user: UserType) => {
    setSelectedUser(user);
    populateEditForm(user);
    setIsEditDialogOpen(true);
  };

  const handleDeleteClick = (user: UserType) => {
    setUserToDelete(user);
    setIsDeleteDialogOpen(true);
  };

  const handleBlockClick = (user: UserType) => {
    if (user.isActive) {
      setUserToBlock(user);
      setIsBlockDialogOpen(true);
    } else {
      unblockUserMutation.mutate(user.id);
    }
  };

  const confirmDelete = () => {
    if (userToDelete) {
      deleteUserMutation.mutate(userToDelete.id);
    }
  };

  const confirmBlock = () => {
    if (userToBlock) {
      blockUserMutation.mutate(userToBlock.id);
    }
  };

  // Stats
  const activeUsers = users.filter((u) => u.isActive).length;
  const adminUsers = users.filter((u) => u.role === 'admin').length;

  // Helper functions
  const getRoleBadge = (role: string) => {
    if (role === 'admin') {
      return (
        <Badge className="bg-purple-500 hover:bg-purple-600">
          <UserCheck className="mr-1 h-3 w-3" />
          Admin
        </Badge>
      );
    }
    return (
      <Badge variant="secondary">
        <User className="mr-1 h-3 w-3" />
        User
      </Badge>
    );
  };

  const getStatusBadge = (isActive: boolean) => {
    if (isActive) {
      return (
        <Badge variant="default" className="bg-green-500">
          <CheckCircle className="mr-1 h-3 w-3" />
          Active
        </Badge>
      );
    }
    return (
      <Badge variant="destructive">
        <Ban className="mr-1 h-3 w-3" />
        Blocked
      </Badge>
    );
  };

  // Pagination handlers
  const goToFirstPage = () => setCurrentPage(1);
  const goToPreviousPage = () => setCurrentPage((p) => Math.max(1, p - 1));
  const goToNextPage = () => setCurrentPage((p) => Math.min(totalPages, p + 1));
  const goToLastPage = () => setCurrentPage(totalPages);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Users</h1>
          <p className="text-muted-foreground mt-1">
            Manage VPN users and their subscriptions
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExportToExcel}>
            <Download className="mr-2 h-4 w-4" />
            Export Excel
          </Button>
          <Button onClick={() => setIsCreateDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add User
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Users</CardTitle>
            <UsersIcon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalUsers.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              {users.length} showing on this page
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
            <Badge variant="default" className="bg-green-500">
              Active
            </Badge>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeUsers}</div>
            <p className="text-xs text-muted-foreground">
              {totalUsers > 0 ? Math.round((activeUsers / totalUsers) * 100) : 0}% of total
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Admins</CardTitle>
            <Badge className="bg-purple-500">Admin</Badge>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{adminUsers}</div>
            <p className="text-xs text-muted-foreground">
              {totalUsers > 0 ? Math.round((adminUsers / totalUsers) * 100) : 0}% of total
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Blocked</CardTitle>
            <Badge variant="destructive">Blocked</Badge>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalUsers - activeUsers}</div>
            <p className="text-xs text-muted-foreground">
              Restricted access
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filters */}
      <div className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by username, name, or Telegram ID..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setShowFilters(!showFilters)}
              className={showFilters ? 'bg-accent' : ''}
            >
              <Filter className="mr-2 h-4 w-4" />
              Filters
              {hasActiveFilters && (
                <Badge variant="secondary" className="ml-2">
                  Active
                </Badge>
              )}
            </Button>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="mr-1 h-4 w-4" />
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Advanced Filters Panel */}
        {showFilters && (
          <Card className="bg-muted/50">
            <CardContent className="pt-6">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-2">
                  <Label className="text-xs font-medium flex items-center gap-1">
                    <Hash className="h-3 w-3" />
                    User ID
                  </Label>
                  <Input
                    placeholder="Filter by ID..."
                    value={filters.id}
                    onChange={(e) => handleFilterChange('id', e.target.value)}
                    className="h-8"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium flex items-center gap-1">
                    <User className="h-3 w-3" />
                    Username
                  </Label>
                  <Input
                    placeholder="Filter by username..."
                    value={filters.username}
                    onChange={(e) => handleFilterChange('username', e.target.value)}
                    className="h-8"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium flex items-center gap-1">
                    <Mail className="h-3 w-3" />
                    Telegram ID
                  </Label>
                  <Input
                    placeholder="Filter by Telegram ID..."
                    value={filters.telegramId}
                    onChange={(e) => handleFilterChange('telegramId', e.target.value)}
                    className="h-8"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Role</Label>
                  <select
                    value={filters.role}
                    onChange={(e) => handleFilterChange('role', e.target.value)}
                    className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="all">All Roles</option>
                    <option value="admin">Admin</option>
                    <option value="user">User</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Status</Label>
                  <select
                    value={filters.isActive}
                    onChange={(e) => handleFilterChange('isActive', e.target.value)}
                    className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="all">All Status</option>
                    <option value="active">Active</option>
                    <option value="inactive">Blocked</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    From Date
                  </Label>
                  <Input
                    type="date"
                    value={filters.dateFrom}
                    onChange={(e) => handleFilterChange('dateFrom', e.target.value)}
                    className="h-8"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    To Date
                  </Label>
                  <Input
                    type="date"
                    value={filters.dateTo}
                    onChange={(e) => handleFilterChange('dateTo', e.target.value)}
                    className="h-8"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Users Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Users</CardTitle>
          <CardDescription>
            Manage users with filtering, sorting, and pagination
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <div className="text-center py-12 text-muted-foreground">
              <UserX className="mx-auto h-12 w-12 mb-4" />
              <p>Failed to load users</p>
              <p className="text-sm">{(error as Error)?.message}</p>
            </div>
          ) : users.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <UsersIcon className="mx-auto h-12 w-12 opacity-50 mb-4" />
              <p>No users found</p>
              {hasActiveFilters && (
                <Button variant="link" onClick={clearFilters}>
                  Clear filters to see all users
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead
                      className="cursor-pointer"
                      onClick={() => handleSort('id')}
                    >
                      <div className="flex items-center">
                        ID
                        {getSortIcon('id')}
                      </div>
                    </TableHead>
                    <TableHead
                      className="cursor-pointer"
                      onClick={() => handleSort('username')}
                    >
                      <div className="flex items-center">
                        Username
                        {getSortIcon('username')}
                      </div>
                    </TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead
                      className="cursor-pointer"
                      onClick={() => handleSort('telegramId')}
                    >
                      <div className="flex items-center">
                        Telegram ID
                        {getSortIcon('telegramId')}
                      </div>
                    </TableHead>
                    <TableHead
                      className="cursor-pointer"
                      onClick={() => handleSort('role')}
                    >
                      <div className="flex items-center">
                        Role
                        {getSortIcon('role')}
                      </div>
                    </TableHead>
                    <TableHead
                      className="cursor-pointer"
                      onClick={() => handleSort('isActive')}
                    >
                      <div className="flex items-center">
                        Status
                        {getSortIcon('isActive')}
                      </div>
                    </TableHead>
                    <TableHead
                      className="cursor-pointer"
                      onClick={() => handleSort('lastLoginAt')}
                    >
                      <div className="flex items-center">
                        Last Login
                        {getSortIcon('lastLoginAt')}
                      </div>
                    </TableHead>
                    <TableHead
                      className="cursor-pointer"
                      onClick={() => handleSort('createdAt')}
                    >
                      <div className="flex items-center">
                        Created
                        {getSortIcon('createdAt')}
                      </div>
                    </TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => (
                    <TableRow
                      key={user.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => handleViewDetails(user)}
                    >
                      <TableCell className="font-mono text-xs">{user.id}</TableCell>
                      <TableCell className="font-medium">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleViewDetails(user);
                          }}
                          className="hover:text-primary hover:underline flex items-center gap-1"
                        >
                          {user.username}
                          <ExternalLink className="h-3 w-3 opacity-50" />
                        </button>
                      </TableCell>
                      <TableCell>
                        {user.firstName || user.lastName
                          ? `${user.firstName || ''} ${user.lastName || ''}`.trim()
                          : '-'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {user.telegramId || '-'}
                      </TableCell>
                      <TableCell>{getRoleBadge(user.role)}</TableCell>
                      <TableCell>{getStatusBadge(user.isActive)}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {user.lastLoginAt
                          ? new Date(user.lastLoginAt).toLocaleDateString()
                          : 'Never'}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(user.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                              <span className="sr-only">Open menu</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Actions</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleViewDetails(user);
                              }}
                            >
                              <Eye className="mr-2 h-4 w-4" />
                              Full Profile
                              <ExternalLink className="ml-auto h-3 w-3 opacity-50" />
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleEditClick(user);
                              }}
                            >
                              <Edit className="mr-2 h-4 w-4" />
                              Edit User
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleBlockClick(user);
                              }}
                              disabled={blockUserMutation.isPending || unblockUserMutation.isPending}
                            >
                              {user.isActive ? (
                                <>
                                  <Ban className="mr-2 h-4 w-4 text-red-500" />
                                  <span className="text-red-500">Block User</span>
                                </>
                              ) : (
                                <>
                                  <CheckCircle className="mr-2 h-4 w-4 text-green-500" />
                                  <span className="text-green-500">Unblock User</span>
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteClick(user);
                              }}
                              className="text-red-600"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Pagination */}
          {!isLoading && !isError && users.length > 0 && (
            <div className="flex items-center justify-between mt-6">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Show</span>
                  <select
                    value={itemsPerPage}
                    onChange={(e) => {
                      setItemsPerPage(Number(e.target.value));
                      setCurrentPage(1);
                    }}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                  >
                    {ITEMS_PER_PAGE_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                  <span className="text-sm text-muted-foreground">entries</span>
                </div>
                <span className="text-sm text-muted-foreground">
                  Showing {((currentPage - 1) * itemsPerPage) + 1} to{' '}
                  {Math.min(currentPage * itemsPerPage, totalUsers)} of {totalUsers} entries
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={goToFirstPage}
                  disabled={currentPage === 1}
                  className="h-8 w-8"
                >
                  <ChevronsLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={goToPreviousPage}
                  disabled={currentPage === 1}
                  className="h-8 w-8"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm px-3">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={goToNextPage}
                  disabled={currentPage === totalPages}
                  className="h-8 w-8"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={goToLastPage}
                  disabled={currentPage === totalPages}
                  className="h-8 w-8"
                >
                  <ChevronsRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* User Details Dialog */}
      <Dialog open={isDetailDialogOpen} onOpenChange={setIsDetailDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>User Details</DialogTitle>
            <DialogDescription>
              Detailed information about {selectedUser?.username}
            </DialogDescription>
          </DialogHeader>
          {selectedUser && (
            <div className="space-y-6 py-4">
              {/* User Header */}
              <div className="flex items-center gap-4">
                <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="h-8 w-8 text-primary" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">{selectedUser.username}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    {getRoleBadge(selectedUser.role)}
                    {getStatusBadge(selectedUser.isActive)}
                  </div>
                </div>
              </div>

              {/* User Info Grid */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">User ID</Label>
                  <p className="font-mono text-sm">{selectedUser.id}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Telegram ID</Label>
                  <p className="font-mono text-sm">{selectedUser.telegramId || '-'}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">First Name</Label>
                  <p className="text-sm">{selectedUser.firstName || '-'}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Last Name</Label>
                  <p className="text-sm">{selectedUser.lastName || '-'}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Created At</Label>
                  <p className="text-sm">
                    {new Date(selectedUser.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Last Login</Label>
                  <p className="text-sm">
                    {selectedUser.lastLoginAt
                      ? new Date(selectedUser.lastLoginAt).toLocaleString()
                      : 'Never'}
                  </p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Updated At</Label>
                  <p className="text-sm">
                    {new Date(selectedUser.updatedAt).toLocaleString()}
                  </p>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-4 border-t">
                <Button
                  variant="outline"
                  onClick={() => {
                    setIsDetailDialogOpen(false);
                    handleEditClick(selectedUser);
                  }}
                >
                  <Edit className="mr-2 h-4 w-4" />
                  Edit User
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleBlockClick(selectedUser)}
                  className={selectedUser.isActive ? 'text-red-600' : 'text-green-600'}
                >
                  {selectedUser.isActive ? (
                    <>
                      <Ban className="mr-2 h-4 w-4" />
                      Block User
                    </>
                  ) : (
                    <>
                      <CheckCircle className="mr-2 h-4 w-4" />
                      Unblock User
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Create User Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create New User</DialogTitle>
            <DialogDescription>Add a new user to the system</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="username">
                Username <span className="text-red-500">*</span>
              </Label>
              <Input
                id="username"
                value={formData.username}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                placeholder="Enter username"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstName">First Name</Label>
                <Input
                  id="firstName"
                  value={formData.firstName}
                  onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                  placeholder="First name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last Name</Label>
                <Input
                  id="lastName"
                  value={formData.lastName}
                  onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                  placeholder="Last name"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="telegramId">Telegram ID</Label>
              <Input
                id="telegramId"
                value={formData.telegramId}
                onChange={(e) => setFormData({ ...formData, telegramId: e.target.value })}
                placeholder="Telegram ID (optional)"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="role">Role</Label>
              <select
                id="role"
                value={formData.role}
                onChange={(e) =>
                  setFormData({ ...formData, role: e.target.value as 'admin' | 'user' })
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2"
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="isActive"
                checked={formData.isActive}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, isActive: checked })
                }
              />
              <Label htmlFor="isActive">Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateUser}
              disabled={!formData.username || createUserMutation.isPending}
            >
              {createUserMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>Update user information</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-username">
                Username <span className="text-red-500">*</span>
              </Label>
              <Input
                id="edit-username"
                value={formData.username}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                placeholder="Enter username"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-firstName">First Name</Label>
                <Input
                  id="edit-firstName"
                  value={formData.firstName}
                  onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                  placeholder="First name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-lastName">Last Name</Label>
                <Input
                  id="edit-lastName"
                  value={formData.lastName}
                  onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                  placeholder="Last name"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-telegramId">Telegram ID</Label>
              <Input
                id="edit-telegramId"
                value={formData.telegramId}
                onChange={(e) => setFormData({ ...formData, telegramId: e.target.value })}
                placeholder="Telegram ID (optional)"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-role">Role</Label>
              <select
                id="edit-role"
                value={formData.role}
                onChange={(e) =>
                  setFormData({ ...formData, role: e.target.value as 'admin' | 'user' })
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2"
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="edit-isActive"
                checked={formData.isActive}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, isActive: checked })
                }
              />
              <Label htmlFor="edit-isActive">Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleUpdateUser}
              disabled={!formData.username || updateUserMutation.isPending}
            >
              {updateUserMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Update User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete User</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the user "{userToDelete?.username}"? This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive hover:bg-destructive/90"
              disabled={deleteUserMutation.isPending}
            >
              {deleteUserMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Block/Unblock Confirmation */}
      <AlertDialog open={isBlockDialogOpen} onOpenChange={setIsBlockDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Block User</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to block "{userToBlock?.username}"? They will not be
              able to access the system until unblocked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmBlock}
              className="bg-destructive hover:bg-destructive/90"
              disabled={blockUserMutation.isPending}
            >
              {blockUserMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Block User
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
