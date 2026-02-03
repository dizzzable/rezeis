import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CreditCard,
  Search,
  Plus,
  Filter,
  Download,
  Eye,
  RefreshCw,
  XCircle,
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
  Clock,
  AlertCircle,
  Ban,
  Hash,
  User,
  Package,
  Calendar,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
import { subscriptionsService } from '@/api/subscriptions.service';
import { plansService } from '@/api/plans.service';
import type {
  Subscription,
  CreateSubscriptionDTO,
  SubscriptionStatus,
} from '@/types/entity.types';
import * as XLSX from 'xlsx';

// Types for sorting and filtering
type SortField = 'id' | 'userId' | 'planId' | 'status' | 'startDate' | 'endDate' | 'createdAt';
type SortDirection = 'asc' | 'desc';

interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

interface FilterConfig {
  id: string;
  userId: string;
  planId: string;
  status: 'all' | SubscriptionStatus;
  dateFrom: string;
  dateTo: string;
}

const ITEMS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

/**
 * Subscriptions page component with advanced features
 * Features: filtering, sorting, pagination, export, detail view, quick actions
 */
export default function Subscriptions(): React.ReactElement {
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
    id: '',
    userId: '',
    planId: '',
    status: 'all',
    dateFrom: '',
    dateTo: '',
  });

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  // Dialog states
  const [selectedSubscription, setSelectedSubscription] = useState<Subscription | null>(null);
  const [isDetailDialogOpen, setIsDetailDialogOpen] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [subscriptionToDelete, setSubscriptionToDelete] = useState<Subscription | null>(null);
  const [subscriptionToCancel, setSubscriptionToCancel] = useState<Subscription | null>(null);
  const [isCancelDialogOpen, setIsCancelDialogOpen] = useState(false);
  const [subscriptionToRenew, setSubscriptionToRenew] = useState<Subscription | null>(null);
  const [isRenewDialogOpen, setIsRenewDialogOpen] = useState(false);

  // Form state for create
  const [formData, setFormData] = useState<Partial<CreateSubscriptionDTO>>({
    userId: '',
    planId: '',
    status: 'active',
    startDate: new Date().toISOString().split('T')[0],
    endDate: '',
  });

  // Fetch subscriptions
  const {
    data: subscriptionsResponse,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['subscriptions', currentPage, itemsPerPage, searchQuery, filters, sortConfig],
    queryFn: () =>
      subscriptionsService.getSubscriptions({
        page: currentPage,
        limit: itemsPerPage,
        userId: filters.userId || undefined,
        planId: filters.planId || undefined,
        status: filters.status !== 'all' ? filters.status : undefined,
      }),
  });

  // Fetch plans for create form
  const { data: plans = [] } = useQuery({
    queryKey: ['plans'],
    queryFn: () => plansService.getPlans(),
  });

  const subscriptions = subscriptionsResponse?.data || [];
  const totalSubscriptions = subscriptionsResponse?.total || 0;
  const totalPages = Math.ceil(totalSubscriptions / itemsPerPage);

  // Fetch expiring subscriptions
  const { data: expiringSubscriptions = [] } = useQuery({
    queryKey: ['subscriptions-expiring'],
    queryFn: () => subscriptionsService.getExpiringSubscriptions(7),
  });

  // Mutations
  const createSubscriptionMutation = useMutation({
    mutationFn: (data: CreateSubscriptionDTO) => subscriptionsService.createSubscription(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      setIsCreateDialogOpen(false);
      resetForm();
    },
  });

  const deleteSubscriptionMutation = useMutation({
    mutationFn: (id: string) => subscriptionsService.deleteSubscription(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      setIsDeleteDialogOpen(false);
      setSubscriptionToDelete(null);
    },
  });

  const renewSubscriptionMutation = useMutation({
    mutationFn: (id: string) => subscriptionsService.renewSubscription(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      setIsRenewDialogOpen(false);
      setSubscriptionToRenew(null);
    },
  });

  const cancelSubscriptionMutation = useMutation({
    mutationFn: (id: string) => subscriptionsService.cancelSubscription(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      setIsCancelDialogOpen(false);
      setSubscriptionToCancel(null);
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
      id: '',
      userId: '',
      planId: '',
      status: 'all',
      dateFrom: '',
      dateTo: '',
    });
    setSearchQuery('');
    setCurrentPage(1);
  };

  const hasActiveFilters = useMemo(() => {
    return (
      filters.id ||
      filters.userId ||
      filters.planId ||
      filters.status !== 'all' ||
      filters.dateFrom ||
      filters.dateTo ||
      searchQuery
    );
  }, [filters, searchQuery]);

  // Export to Excel
  const handleExportToExcel = () => {
    const exportData = subscriptions.map((sub) => ({
      ID: sub.id,
      'User ID': sub.userId,
      'Plan ID': sub.planId,
      Status: sub.status,
      'Start Date': new Date(sub.startDate).toLocaleDateString(),
      'End Date': new Date(sub.endDate).toLocaleDateString(),
      'Remnawave UUID': sub.remnawaveUuid || '-',
      'Created At': new Date(sub.createdAt).toLocaleString(),
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Subscriptions');

    const colWidths = [
      { wch: 10 },
      { wch: 15 },
      { wch: 15 },
      { wch: 12 },
      { wch: 15 },
      { wch: 15 },
      { wch: 20 },
      { wch: 20 },
    ];
    ws['!cols'] = colWidths;

    const timestamp = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `subscriptions-export-${timestamp}.xlsx`);
  };

  // Form handlers
  const resetForm = () => {
    setFormData({
      userId: '',
      planId: '',
      status: 'active',
      startDate: new Date().toISOString().split('T')[0],
      endDate: '',
    });
  };

  const handleCreateSubscription = () => {
    if (!formData.userId || !formData.planId || !formData.endDate) return;
    createSubscriptionMutation.mutate(formData as CreateSubscriptionDTO);
  };

  // Action handlers
  const handleViewDetails = (subscription: Subscription) => {
    setSelectedSubscription(subscription);
    setIsDetailDialogOpen(true);
  };

  const handleDeleteClick = (subscription: Subscription) => {
    setSubscriptionToDelete(subscription);
    setIsDeleteDialogOpen(true);
  };

  const handleRenewClick = (subscription: Subscription) => {
    setSubscriptionToRenew(subscription);
    setIsRenewDialogOpen(true);
  };

  const handleCancelClick = (subscription: Subscription) => {
    setSubscriptionToCancel(subscription);
    setIsCancelDialogOpen(true);
  };

  const confirmDelete = () => {
    if (subscriptionToDelete) {
      deleteSubscriptionMutation.mutate(subscriptionToDelete.id);
    }
  };

  const confirmRenew = () => {
    if (subscriptionToRenew) {
      renewSubscriptionMutation.mutate(subscriptionToRenew.id);
    }
  };

  const confirmCancel = () => {
    if (subscriptionToCancel) {
      cancelSubscriptionMutation.mutate(subscriptionToCancel.id);
    }
  };

  // Helper functions
  const getStatusBadge = (status: SubscriptionStatus) => {
    switch (status) {
      case 'active':
        return (
          <Badge variant="default" className="bg-green-500">
            <CheckCircle className="mr-1 h-3 w-3" />
            Active
          </Badge>
        );
      case 'expired':
        return (
          <Badge variant="secondary">
            <Clock className="mr-1 h-3 w-3" />
            Expired
          </Badge>
        );
      case 'cancelled':
        return (
          <Badge variant="destructive">
            <Ban className="mr-1 h-3 w-3" />
            Cancelled
          </Badge>
        );
      case 'pending':
        return (
          <Badge variant="outline">
            <AlertCircle className="mr-1 h-3 w-3" />
            Pending
          </Badge>
        );
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const getDaysUntilExpiry = (endDate: string) => {
    const end = new Date(endDate);
    const now = new Date();
    const diffTime = end.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  };

  // Stats
  const activeCount = subscriptions.filter((s) => s.status === 'active').length;
  const cancelledCount = subscriptions.filter((s) => s.status === 'cancelled').length;

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
          <h1 className="text-3xl font-bold tracking-tight">Subscriptions</h1>
          <p className="text-muted-foreground mt-1">Manage VPN subscriptions and renewals</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExportToExcel}>
            <Download className="mr-2 h-4 w-4" />
            Export Excel
          </Button>
          <Button onClick={() => setIsCreateDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Subscription
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Subscriptions</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalSubscriptions.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">{subscriptions.length} showing on this page</p>
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
            <div className="text-2xl font-bold">{activeCount}</div>
            <p className="text-xs text-muted-foreground">
              {totalSubscriptions > 0 ? Math.round((activeCount / totalSubscriptions) * 100) : 0}% of total
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Expiring Soon</CardTitle>
            <Badge variant="destructive">Expiring</Badge>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{expiringSubscriptions.length}</div>
            <p className="text-xs text-muted-foreground">Within 7 days</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Cancelled</CardTitle>
            <Badge variant="destructive">Cancelled</Badge>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{cancelledCount}</div>
            <p className="text-xs text-muted-foreground">Manual cancellations</p>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filters */}
      <div className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by user ID or plan ID..."
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
                    Subscription ID
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
                  <Label className="text-xs font-medium flex items-center gap-1">
                    <Package className="h-3 w-3" />
                    Plan ID
                  </Label>
                  <Input
                    placeholder="Filter by plan ID..."
                    value={filters.planId}
                    onChange={(e) => handleFilterChange('planId', e.target.value)}
                    className="h-8"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Status</Label>
                  <select
                    value={filters.status}
                    onChange={(e) => handleFilterChange('status', e.target.value)}
                    className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="all">All Status</option>
                    <option value="active">Active</option>
                    <option value="expired">Expired</option>
                    <option value="cancelled">Cancelled</option>
                    <option value="pending">Pending</option>
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

      {/* Subscriptions Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Subscriptions</CardTitle>
          <CardDescription>Manage subscriptions with filtering, sorting, and pagination</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <div className="text-center py-12 text-muted-foreground">
              <XCircle className="mx-auto h-12 w-12 mb-4" />
              <p>Failed to load subscriptions</p>
              <p className="text-sm">{(error as Error)?.message}</p>
            </div>
          ) : subscriptions.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <CreditCard className="mx-auto h-12 w-12 opacity-50 mb-4" />
              <p>No subscriptions found</p>
              {hasActiveFilters && (
                <Button variant="link" onClick={clearFilters}>
                  Clear filters to see all subscriptions
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
                    <TableHead className="cursor-pointer" onClick={() => handleSort('userId')}>
                      <div className="flex items-center">
                        User ID
                        {getSortIcon('userId')}
                      </div>
                    </TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('planId')}>
                      <div className="flex items-center">
                        Plan ID
                        {getSortIcon('planId')}
                      </div>
                    </TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('status')}>
                      <div className="flex items-center">
                        Status
                        {getSortIcon('status')}
                      </div>
                    </TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('startDate')}>
                      <div className="flex items-center">
                        Start Date
                        {getSortIcon('startDate')}
                      </div>
                    </TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('endDate')}>
                      <div className="flex items-center">
                        End Date
                        {getSortIcon('endDate')}
                      </div>
                    </TableHead>
                    <TableHead>Days Left</TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {subscriptions.map((subscription) => {
                    const daysLeft = getDaysUntilExpiry(subscription.endDate);
                    return (
                      <TableRow key={subscription.id}>
                        <TableCell className="font-mono text-xs">{subscription.id}</TableCell>
                        <TableCell className="font-mono text-xs">{subscription.userId}</TableCell>
                        <TableCell className="font-mono text-xs">{subscription.planId}</TableCell>
                        <TableCell>{getStatusBadge(subscription.status)}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {new Date(subscription.startDate).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {new Date(subscription.endDate).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          {subscription.status === 'active' ? (
                            <Badge
                              variant={daysLeft <= 7 ? 'destructive' : daysLeft <= 30 ? 'secondary' : 'outline'}
                            >
                              {daysLeft > 0 ? `${daysLeft} days` : 'Expired'}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-sm">-</span>
                          )}
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
                              <DropdownMenuItem onClick={() => handleViewDetails(subscription)}>
                                <Eye className="mr-2 h-4 w-4" />
                                View Details
                              </DropdownMenuItem>
                              {subscription.status === 'active' && (
                                <>
                                  <DropdownMenuItem
                                    onClick={() => handleRenewClick(subscription)}
                                    disabled={renewSubscriptionMutation.isPending}
                                  >
                                    <RefreshCw className="mr-2 h-4 w-4 text-blue-500" />
                                    <span className="text-blue-500">Renew Subscription</span>
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => handleCancelClick(subscription)}
                                    disabled={cancelSubscriptionMutation.isPending}
                                  >
                                    <XCircle className="mr-2 h-4 w-4 text-red-500" />
                                    <span className="text-red-500">Cancel Subscription</span>
                                  </DropdownMenuItem>
                                </>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => handleDeleteClick(subscription)}
                                className="text-red-600"
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Pagination */}
          {!isLoading && !isError && subscriptions.length > 0 && (
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
                  {Math.min(currentPage * itemsPerPage, totalSubscriptions)} of {totalSubscriptions} entries
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

      {/* Subscription Details Dialog */}
      <Dialog open={isDetailDialogOpen} onOpenChange={setIsDetailDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Subscription Details</DialogTitle>
            <DialogDescription>Detailed information about subscription #{selectedSubscription?.id}</DialogDescription>
          </DialogHeader>
          {selectedSubscription && (
            <div className="space-y-6 py-4">
              {/* Subscription Header */}
              <div className="flex items-center gap-4">
                <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <CreditCard className="h-8 w-8 text-primary" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">Subscription #{selectedSubscription.id}</h3>
                  <div className="flex items-center gap-2 mt-1">{getStatusBadge(selectedSubscription.status)}</div>
                </div>
              </div>

              {/* Subscription Info Grid */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Subscription ID</Label>
                  <p className="font-mono text-sm">{selectedSubscription.id}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Remnawave UUID</Label>
                  <p className="font-mono text-sm">{selectedSubscription.remnawaveUuid || '-'}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">User ID</Label>
                  <p className="font-mono text-sm">{selectedSubscription.userId}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Plan ID</Label>
                  <p className="font-mono text-sm">{selectedSubscription.planId}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Start Date</Label>
                  <p className="text-sm">{new Date(selectedSubscription.startDate).toLocaleString()}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">End Date</Label>
                  <p className="text-sm">{new Date(selectedSubscription.endDate).toLocaleString()}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Created At</Label>
                  <p className="text-sm">{new Date(selectedSubscription.createdAt).toLocaleString()}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Updated At</Label>
                  <p className="text-sm">{new Date(selectedSubscription.updatedAt).toLocaleString()}</p>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-4 border-t">
                {selectedSubscription.status === 'active' && (
                  <>
                    <Button variant="outline" onClick={() => handleRenewClick(selectedSubscription)}>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Renew
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleCancelClick(selectedSubscription)}
                      className="text-red-600"
                    >
                      <XCircle className="mr-2 h-4 w-4" />
                      Cancel
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Create Subscription Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create New Subscription</DialogTitle>
            <DialogDescription>Add a new subscription for a user</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="userId">
                User ID <span className="text-red-500">*</span>
              </Label>
              <Input
                id="userId"
                value={formData.userId}
                onChange={(e) => setFormData({ ...formData, userId: e.target.value })}
                placeholder="Enter user ID"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="planId">
                Plan <span className="text-red-500">*</span>
              </Label>
              <select
                id="planId"
                value={formData.planId}
                onChange={(e) => setFormData({ ...formData, planId: e.target.value })}
                className="w-full rounded-md border border-input bg-background px-3 py-2"
              >
                <option value="">Select a plan</option>
                {plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name} (${plan.price} / {plan.durationDays} days)
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startDate">Start Date</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={formData.startDate}
                  onChange={(e) => setFormData({ ...formData, startDate: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">
                  End Date <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="endDate"
                  type="date"
                  value={formData.endDate}
                  onChange={(e) => setFormData({ ...formData, endDate: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="status">Status</Label>
              <select
                id="status"
                value={formData.status}
                onChange={(e) =>
                  setFormData({ ...formData, status: e.target.value as SubscriptionStatus })
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2"
              >
                <option value="active">Active</option>
                <option value="pending">Pending</option>
                <option value="expired">Expired</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateSubscription}
              disabled={!formData.userId || !formData.planId || !formData.endDate || createSubscriptionMutation.isPending}
            >
              {createSubscriptionMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Subscription
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Subscription</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete subscription #{subscriptionToDelete?.id}? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive hover:bg-destructive/90"
              disabled={deleteSubscriptionMutation.isPending}
            >
              {deleteSubscriptionMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Renew Confirmation */}
      <AlertDialog open={isRenewDialogOpen} onOpenChange={setIsRenewDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Renew Subscription</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to renew subscription #{subscriptionToRenew?.id}? This will extend the subscription
              period.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRenew} disabled={renewSubscriptionMutation.isPending}>
              {renewSubscriptionMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Renew Subscription
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel Confirmation */}
      <AlertDialog open={isCancelDialogOpen} onOpenChange={setIsCancelDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Subscription</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to cancel subscription #{subscriptionToCancel?.id}? This will mark the subscription
              as cancelled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCancel}
              className="bg-destructive hover:bg-destructive/90"
              disabled={cancelSubscriptionMutation.isPending}
            >
              {cancelSubscriptionMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Cancel Subscription
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
