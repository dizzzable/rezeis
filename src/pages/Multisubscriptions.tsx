import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Layers,
  Search,
  Plus,
  Filter,
  Download,
  Eye,
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
  CheckCircle,
  XCircle,
  User as UserIcon,
  Package,
  Trash2,
  Power,
  PowerOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
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
import { multisubscriptionsService } from '@/api/multisubscriptions.service';
import { usersService } from '@/api/users.service';
import { subscriptionsService } from '@/api/subscriptions.service';
import type {
  Multisubscription,
  CreateMultisubscriptionInput,
  UpdateMultisubscriptionInput,
  User,
} from '@/types/entity.types';
import * as XLSX from 'xlsx';

// Types for sorting and filtering
type SortField = 'id' | 'userId' | 'name' | 'createdAt' | 'updatedAt';
type SortDirection = 'asc' | 'desc';

interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

interface FilterConfig {
  userId: string;
  isActive: 'all' | 'active' | 'inactive';
  search: string;
}

const ITEMS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

/**
 * Multisubscriptions page component
 * Manages bundles of subscriptions assigned to users
 */
export default function Multisubscriptions(): React.ReactElement {
  const queryClient = useQueryClient();

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
    userId: '',
    isActive: 'all',
    search: '',
  });

  // Dialog states
  const [selectedMultisubscription, setSelectedMultisubscription] = useState<Multisubscription | null>(null);
  const [isDetailDialogOpen, setIsDetailDialogOpen] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [multisubscriptionToDelete, setMultisubscriptionToDelete] = useState<Multisubscription | null>(null);
  const [multisubscriptionToToggle, setMultisubscriptionToToggle] = useState<Multisubscription | null>(null);
  const [isToggleDialogOpen, setIsToggleDialogOpen] = useState(false);

  // Form state for create/edit
  const [formData, setFormData] = useState<Partial<CreateMultisubscriptionInput>>({
    userId: '',
    name: '',
    description: '',
    subscriptionIds: [],
    isActive: true,
  });

  // User search state for forms
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);



  // Fetch multisubscriptions
  const {
    data: multisubscriptionsResponse,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['multisubscriptions', currentPage, itemsPerPage, filters, sortConfig],
    queryFn: () =>
      multisubscriptionsService.getMultisubscriptions({
        page: currentPage,
        limit: itemsPerPage,
        userId: filters.userId || undefined,
        isActive: filters.isActive !== 'all' ? filters.isActive === 'active' : undefined,
        search: filters.search || undefined,
        sortBy: sortConfig.field === 'createdAt' ? 'created_at' : sortConfig.field === 'updatedAt' ? 'updated_at' : sortConfig.field,
        sortOrder: sortConfig.direction,
      }),
  });

  // Fetch statistics
  const { data: statistics } = useQuery({
    queryKey: ['multisubscriptions-statistics'],
    queryFn: () => multisubscriptionsService.getStatistics(),
  });

  // Fetch users for user selection
  const { data: users = [] } = useQuery({
    queryKey: ['users', userSearchQuery],
    queryFn: () =>
      usersService.getUsers({
        page: 1,
        limit: 50,
        search: userSearchQuery || undefined,
      }).then((res) => res.data),
    enabled: userSearchQuery.length > 2 || isCreateDialogOpen || isEditDialogOpen,
  });

  // Fetch subscriptions for selection
  const { data: subscriptions = [] } = useQuery({
    queryKey: ['subscriptions-for-multisubscription', selectedUser?.id],
    queryFn: () =>
      subscriptionsService.getSubscriptions({
        page: 1,
        limit: 100,
        userId: selectedUser?.id,
        status: 'active',
      }).then((res) => res.data),
    enabled: !!selectedUser?.id && (isCreateDialogOpen || isEditDialogOpen),
  });

  const multisubscriptions = multisubscriptionsResponse?.data || [];
  const totalMultisubscriptions = multisubscriptionsResponse?.total || 0;
  const totalPages = Math.ceil(totalMultisubscriptions / itemsPerPage);

  // Mutations
  const createMultisubscriptionMutation = useMutation({
    mutationFn: (data: CreateMultisubscriptionInput) =>
      multisubscriptionsService.createMultisubscription(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['multisubscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['multisubscriptions-statistics'] });
      setIsCreateDialogOpen(false);
      resetForm();
    },
  });

  const updateMultisubscriptionMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateMultisubscriptionInput }) =>
      multisubscriptionsService.updateMultisubscription(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['multisubscriptions'] });
      setIsEditDialogOpen(false);
      setSelectedMultisubscription(null);
    },
  });

  const deleteMultisubscriptionMutation = useMutation({
    mutationFn: (id: string) => multisubscriptionsService.deleteMultisubscription(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['multisubscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['multisubscriptions-statistics'] });
      setIsDeleteDialogOpen(false);
      setMultisubscriptionToDelete(null);
    },
  });

  const toggleMultisubscriptionMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      multisubscriptionsService.toggleMultisubscriptionStatus(id, isActive),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['multisubscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['multisubscriptions-statistics'] });
      setIsToggleDialogOpen(false);
      setMultisubscriptionToToggle(null);
    },
  });

  // Sorting handler
  const handleSort = (field: SortField) => {
    setSortConfig((current) => ({
      field,
      direction: current.field === field && current.direction === 'asc' ? 'desc' : 'asc',
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
    setCurrentPage(1);
  };

  const clearFilters = () => {
    setFilters({
      userId: '',
      isActive: 'all',
      search: '',
    });
    setCurrentPage(1);
  };

  const hasActiveFilters = useMemo(() => {
    return filters.userId || filters.isActive !== 'all' || filters.search;
  }, [filters]);

  // Export to Excel
  const handleExportToExcel = () => {
    const exportData = multisubscriptions.map((ms) => ({
      ID: ms.id,
      Name: ms.name,
      'User ID': ms.userId,
      Description: ms.description || '-',
      'Subscriptions Count': ms.subscriptionIds.length,
      'Subscription IDs': ms.subscriptionIds.join(', '),
      Status: ms.isActive ? 'Active' : 'Inactive',
      'Created At': new Date(ms.createdAt).toLocaleString(),
      'Updated At': new Date(ms.updatedAt).toLocaleString(),
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Multisubscriptions');

    const colWidths = [
      { wch: 10 },
      { wch: 30 },
      { wch: 15 },
      { wch: 40 },
      { wch: 18 },
      { wch: 50 },
      { wch: 12 },
      { wch: 20 },
      { wch: 20 },
    ];
    ws['!cols'] = colWidths;

    const timestamp = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `multisubscriptions-export-${timestamp}.xlsx`);
  };

  // Form handlers
  const resetForm = () => {
    setFormData({
      userId: '',
      name: '',
      description: '',
      subscriptionIds: [],
      isActive: true,
    });
    setSelectedUser(null);
    setUserSearchQuery('');
  };

  const handleCreateMultisubscription = () => {
    if (!formData.userId || !formData.name || !formData.subscriptionIds?.length) return;
    createMultisubscriptionMutation.mutate(formData as CreateMultisubscriptionInput);
  };

  const handleUpdateMultisubscription = () => {
    if (!selectedMultisubscription || !formData.name) return;
    updateMultisubscriptionMutation.mutate({
      id: selectedMultisubscription.id,
      data: {
        name: formData.name,
        description: formData.description,
        subscriptionIds: formData.subscriptionIds,
        isActive: formData.isActive,
      },
    });
  };

  // Action handlers
  const handleViewDetails = (ms: Multisubscription) => {
    setSelectedMultisubscription(ms);
    setIsDetailDialogOpen(true);
  };

  const handleEditClick = (ms: Multisubscription) => {
    setSelectedMultisubscription(ms);
    setFormData({
      userId: ms.userId,
      name: ms.name,
      description: ms.description,
      subscriptionIds: ms.subscriptionIds,
      isActive: ms.isActive,
    });
    // Find and set the user
    const user = users.find((u) => u.id === ms.userId);
    if (user) {
      setSelectedUser(user);
    }
    setIsEditDialogOpen(true);
  };

  const handleDeleteClick = (ms: Multisubscription) => {
    setMultisubscriptionToDelete(ms);
    setIsDeleteDialogOpen(true);
  };

  const handleToggleClick = (ms: Multisubscription) => {
    setMultisubscriptionToToggle(ms);
    setIsToggleDialogOpen(true);
  };

  const confirmDelete = () => {
    if (multisubscriptionToDelete) {
      deleteMultisubscriptionMutation.mutate(multisubscriptionToDelete.id);
    }
  };

  const confirmToggle = () => {
    if (multisubscriptionToToggle) {
      toggleMultisubscriptionMutation.mutate({
        id: multisubscriptionToToggle.id,
        isActive: !multisubscriptionToToggle.isActive,
      });
    }
  };

  // Subscription selection handler
  const toggleSubscriptionSelection = (subscriptionId: string) => {
    setFormData((prev) => {
      const currentIds = prev.subscriptionIds || [];
      const newIds = currentIds.includes(subscriptionId)
        ? currentIds.filter((id) => id !== subscriptionId)
        : [...currentIds, subscriptionId];
      return { ...prev, subscriptionIds: newIds };
    });
  };

  // Helper functions
  const getStatusBadge = (isActive: boolean) => {
    return isActive ? (
      <Badge variant="default" className="bg-green-500">
        <CheckCircle className="mr-1 h-3 w-3" />
        Active
      </Badge>
    ) : (
      <Badge variant="secondary">
        <XCircle className="mr-1 h-3 w-3" />
        Inactive
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
          <h1 className="text-3xl font-bold tracking-tight">Multisubscriptions</h1>
          <p className="text-muted-foreground mt-1">Manage bundles of subscriptions assigned to users</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExportToExcel}>
            <Download className="mr-2 h-4 w-4" />
            Export Excel
          </Button>
          <Button onClick={() => setIsCreateDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Bundle
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Bundles</CardTitle>
            <Layers className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statistics?.total || 0}</div>
            <p className="text-xs text-muted-foreground">{multisubscriptions.length} showing on this page</p>
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
            <div className="text-2xl font-bold">{statistics?.active || 0}</div>
            <p className="text-xs text-muted-foreground">
              {statistics?.total ? Math.round((statistics.active / statistics.total) * 100) : 0}% of total
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Inactive</CardTitle>
            <Badge variant="secondary">Inactive</Badge>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statistics?.inactive || 0}</div>
            <p className="text-xs text-muted-foreground">Disabled bundles</p>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filters */}
      <div className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name..."
              value={filters.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
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
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-2">
                  <Label className="text-xs font-medium flex items-center gap-1">
                    <UserIcon className="h-3 w-3" />
                    User ID
                  </Label>
                  <Input
                    placeholder="Filter by user ID..."
                    value={filters.userId}
                    onChange={(e) => handleFilterChange('userId', e.target.value)}
                    className="h-8"
                  />
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
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Multisubscriptions Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Bundles</CardTitle>
          <CardDescription>Manage subscription bundles with filtering and pagination</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <div className="text-center py-12 text-muted-foreground">
              <XCircle className="mx-auto h-12 w-12 mb-4" />
              <p>Failed to load multisubscriptions</p>
              <p className="text-sm">{(error as Error)?.message}</p>
            </div>
          ) : multisubscriptions.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Layers className="mx-auto h-12 w-12 opacity-50 mb-4" />
              <p>No multisubscriptions found</p>
              {hasActiveFilters && (
                <Button variant="link" onClick={clearFilters}>
                  Clear filters to see all bundles
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('id')}>
                      <div className="flex items-center">
                        ID
                        {getSortIcon('id')}
                      </div>
                    </TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('name')}>
                      <div className="flex items-center">
                        Name
                        {getSortIcon('name')}
                      </div>
                    </TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('userId')}>
                      <div className="flex items-center">
                        User
                        {getSortIcon('userId')}
                      </div>
                    </TableHead>
                    <TableHead>Subscriptions</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('createdAt')}>
                      <div className="flex items-center">
                        Created
                        {getSortIcon('createdAt')}
                      </div>
                    </TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {multisubscriptions.map((ms) => (
                    <TableRow key={ms.id}>
                      <TableCell className="font-mono text-xs">{ms.id}</TableCell>
                      <TableCell className="font-medium">{ms.name}</TableCell>
                      <TableCell className="font-mono text-xs">{ms.userId}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{ms.subscriptionIds.length} subs</Badge>
                      </TableCell>
                      <TableCell>{getStatusBadge(ms.isActive)}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(ms.createdAt).toLocaleDateString()}
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
                            <DropdownMenuItem onClick={() => handleViewDetails(ms)}>
                              <Eye className="mr-2 h-4 w-4" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleEditClick(ms)}>
                              <Power className="mr-2 h-4 w-4 text-blue-500" />
                              Edit Bundle
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleToggleClick(ms)}>
                              {ms.isActive ? (
                                <>
                                  <PowerOff className="mr-2 h-4 w-4 text-orange-500" />
                                  <span className="text-orange-500">Deactivate</span>
                                </>
                              ) : (
                                <>
                                  <Power className="mr-2 h-4 w-4 text-green-500" />
                                  <span className="text-green-500">Activate</span>
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => handleDeleteClick(ms)} className="text-red-600">
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
          {!isLoading && !isError && multisubscriptions.length > 0 && (
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
                  {Math.min(currentPage * itemsPerPage, totalMultisubscriptions)} of {totalMultisubscriptions} entries
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

      {/* Create Multisubscription Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create New Bundle</DialogTitle>
            <DialogDescription>Create a bundle of subscriptions for a user</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* User Selection */}
            <div className="space-y-2">
              <Label htmlFor="userSearch">
                Search User <span className="text-red-500">*</span>
              </Label>
              <Input
                id="userSearch"
                value={userSearchQuery}
                onChange={(e) => setUserSearchQuery(e.target.value)}
                placeholder="Type at least 3 characters to search..."
              />
              {userSearchQuery.length > 2 && users.length > 0 && !selectedUser && (
                <div className="border rounded-md max-h-40 overflow-y-auto">
                  {users.map((user) => (
                    <div
                      key={user.id}
                      className="p-2 hover:bg-muted cursor-pointer flex items-center gap-2"
                      onClick={() => {
                        setSelectedUser(user);
                        setFormData((prev) => ({ ...prev, userId: user.id }));
                        setUserSearchQuery(user.username || user.telegramId || '');
                      }}
                    >
                      <UserIcon className="h-4 w-4 text-muted-foreground" />
                      <span>{user.username || user.telegramId}</span>
                      <span className="text-xs text-muted-foreground">({user.id})</span>
                    </div>
                  ))}
                </div>
              )}
              {selectedUser && (
                <div className="flex items-center gap-2 p-2 bg-muted rounded-md">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <span>Selected: {selectedUser.username || selectedUser.telegramId}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-6"
                    onClick={() => {
                      setSelectedUser(null);
                      setFormData((prev) => ({ ...prev, userId: '', subscriptionIds: [] }));
                      setUserSearchQuery('');
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </div>

            {/* Bundle Name */}
            <div className="space-y-2">
              <Label htmlFor="name">
                Bundle Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Premium Access Bundle"
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Optional description for this bundle..."
                rows={3}
              />
            </div>

            {/* Subscriptions Selection */}
            {selectedUser && (
              <div className="space-y-2">
                <Label>
                  Select Subscriptions <span className="text-red-500">*</span>
                  <span className="text-muted-foreground font-normal ml-2">
                    ({formData.subscriptionIds?.length || 0} selected)
                  </span>
                </Label>
                {subscriptions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No active subscriptions found for this user.</p>
                ) : (
                  <div className="border rounded-md max-h-48 overflow-y-auto space-y-1 p-2">
                    {subscriptions.map((sub) => (
                      <div
                        key={sub.id}
                        className="flex items-center gap-2 p-2 hover:bg-muted rounded cursor-pointer"
                        onClick={() => toggleSubscriptionSelection(sub.id)}
                      >
                        <input
                          type="checkbox"
                          checked={formData.subscriptionIds?.includes(sub.id) || false}
                          onChange={() => {}}
                          className="h-4 w-4"
                        />
                        <div className="flex-1">
                          <div className="text-sm font-medium">Subscription #{sub.id.slice(0, 8)}</div>
                          <div className="text-xs text-muted-foreground">
                            Plan: {sub.planId} | Status: {sub.status}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Active Status */}
            <div className="flex items-center gap-2">
              <Switch
                id="isActive"
                checked={formData.isActive}
                onCheckedChange={(checked) => setFormData({ ...formData, isActive: checked })}
              />
              <Label htmlFor="isActive">Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateMultisubscription}
              disabled={
                !formData.userId ||
                !formData.name ||
                !formData.subscriptionIds?.length ||
                createMultisubscriptionMutation.isPending
              }
            >
              {createMultisubscriptionMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Bundle
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Multisubscription Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Bundle</DialogTitle>
            <DialogDescription>Update bundle details and subscriptions</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>User</Label>
              <div className="p-2 bg-muted rounded-md text-sm">
                {selectedUser?.username || selectedUser?.telegramId || selectedMultisubscription?.userId}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="editName">
                Bundle Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="editName"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="editDescription">Description</Label>
              <Textarea
                id="editDescription"
                value={formData.description}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setFormData({ ...formData, description: e.target.value })}
                rows={3}
              />
            </div>

            {subscriptions.length > 0 && (
              <div className="space-y-2">
                <Label>
                  Subscriptions
                  <span className="text-muted-foreground font-normal ml-2">
                    ({formData.subscriptionIds?.length || 0} selected)
                  </span>
                </Label>
                <div className="border rounded-md max-h-48 overflow-y-auto space-y-1 p-2">
                  {subscriptions.map((sub) => (
                    <div
                      key={sub.id}
                      className="flex items-center gap-2 p-2 hover:bg-muted rounded cursor-pointer"
                      onClick={() => toggleSubscriptionSelection(sub.id)}
                    >
                      <input
                        type="checkbox"
                        checked={formData.subscriptionIds?.includes(sub.id) || false}
                        onChange={() => {}}
                        className="h-4 w-4"
                      />
                      <div className="flex-1">
                        <div className="text-sm font-medium">Subscription #{sub.id.slice(0, 8)}</div>
                        <div className="text-xs text-muted-foreground">
                          Plan: {sub.planId} | Status: {sub.status}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Switch
                id="editIsActive"
                checked={formData.isActive}
                onCheckedChange={(checked) => setFormData({ ...formData, isActive: checked })}
              />
              <Label htmlFor="editIsActive">Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleUpdateMultisubscription}
              disabled={!formData.name || updateMultisubscriptionMutation.isPending}
            >
              {updateMultisubscriptionMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail Dialog */}
      <Dialog open={isDetailDialogOpen} onOpenChange={setIsDetailDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Bundle Details</DialogTitle>
            <DialogDescription>Detailed information about this subscription bundle</DialogDescription>
          </DialogHeader>
          {selectedMultisubscription && (
            <div className="space-y-6 py-4">
              <div className="flex items-center gap-4">
                <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <Layers className="h-8 w-8 text-primary" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">{selectedMultisubscription.name}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    {getStatusBadge(selectedMultisubscription.isActive)}
                  </div>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Bundle ID</Label>
                  <p className="font-mono text-sm">{selectedMultisubscription.id}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">User ID</Label>
                  <p className="font-mono text-sm">{selectedMultisubscription.userId}</p>
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">Description</Label>
                  <p className="text-sm">{selectedMultisubscription.description || '-'}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Created At</Label>
                  <p className="text-sm">{new Date(selectedMultisubscription.createdAt).toLocaleString()}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Updated At</Label>
                  <p className="text-sm">{new Date(selectedMultisubscription.updatedAt).toLocaleString()}</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  Subscriptions ({selectedMultisubscription.subscriptionIds.length})
                </Label>
                <div className="border rounded-md p-3 space-y-1">
                  {selectedMultisubscription.subscriptionIds.map((id) => (
                    <div key={id} className="font-mono text-sm flex items-center gap-2">
                      <Package className="h-3 w-3 text-muted-foreground" />
                      {id}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-2 pt-4 border-t">
                <Button variant="outline" onClick={() => handleEditClick(selectedMultisubscription)}>
                  <Power className="mr-2 h-4 w-4" />
                  Edit
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleToggleClick(selectedMultisubscription)}
                >
                  {selectedMultisubscription.isActive ? (
                    <>
                      <PowerOff className="mr-2 h-4 w-4" />
                      Deactivate
                    </>
                  ) : (
                    <>
                      <Power className="mr-2 h-4 w-4" />
                      Activate
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Bundle</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete bundle "{multisubscriptionToDelete?.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive hover:bg-destructive/90"
              disabled={deleteMultisubscriptionMutation.isPending}
            >
              {deleteMultisubscriptionMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Toggle Confirmation */}
      <AlertDialog open={isToggleDialogOpen} onOpenChange={setIsToggleDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {multisubscriptionToToggle?.isActive ? 'Deactivate' : 'Activate'} Bundle
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to {multisubscriptionToToggle?.isActive ? 'deactivate' : 'activate'} bundle "
              {multisubscriptionToToggle?.name}"?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmToggle}
              disabled={toggleMultisubscriptionMutation.isPending}
            >
              {toggleMultisubscriptionMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
