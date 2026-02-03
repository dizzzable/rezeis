import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Users,
  Search,
  Plus,
  Filter,
  Download,
  Eye,
  Edit,
  CheckCircle,
  XCircle,
  Ban,
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
  DollarSign,
  TrendingUp,
  UserCheck,
  UserX,
  Trash2,
  Calendar,
  Hash,
  Wallet,
  Percent,
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
import { partnersService } from '@/api/partners.service';
import type { Partner, CreatePartnerDTO, UpdatePartnerDTO, PartnerStatus } from '@/types/entity.types';
import * as XLSX from 'xlsx';

// Types for sorting and filtering
type SortField = 'id' | 'userId' | 'referralCode' | 'commissionRate' | 'totalEarnings' | 'status' | 'createdAt';
type SortDirection = 'asc' | 'desc';

interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

interface FilterConfig {
  id: string;
  userId: string;
  referralCode: string;
  status: 'all' | PartnerStatus;
  minEarnings: string;
  dateFrom: string;
  dateTo: string;
}

const ITEMS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

/**
 * Partners page component with advanced features
 * Features: filtering, sorting, pagination, export, detail view, quick actions
 */
export default function Partners(): React.ReactElement {
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
    referralCode: '',
    status: 'all',
    minEarnings: '',
    dateFrom: '',
    dateTo: '',
  });

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  // Dialog states
  const [selectedPartner, setSelectedPartner] = useState<Partner | null>(null);
  const [isDetailDialogOpen, setIsDetailDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [partnerToDelete, setPartnerToDelete] = useState<Partner | null>(null);
  const [isApproveDialogOpen, setIsApproveDialogOpen] = useState(false);
  const [partnerToApprove, setPartnerToApprove] = useState<Partner | null>(null);
  const [isRejectDialogOpen, setIsRejectDialogOpen] = useState(false);
  const [partnerToReject, setPartnerToReject] = useState<Partner | null>(null);
  const [isSuspendDialogOpen, setIsSuspendDialogOpen] = useState(false);
  const [partnerToSuspend, setPartnerToSuspend] = useState<Partner | null>(null);

  // Form states for create/edit
  const [formData, setFormData] = useState<Partial<CreatePartnerDTO & UpdatePartnerDTO>>({
    userId: '',
    commissionRate: 10,
    payoutMethod: 'paypal',
    status: 'pending',
  });

  // Fetch partners
  const {
    data: partnersResponse,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['partners', currentPage, itemsPerPage, searchQuery, filters, sortConfig],
    queryFn: () =>
      partnersService.getPartners({
        page: currentPage,
        limit: itemsPerPage,
        search: searchQuery || undefined,
        status: filters.status !== 'all' ? filters.status : undefined,
        sortBy: sortConfig.field,
        sortOrder: sortConfig.direction,
      }),
  });

  // Fetch partner stats
  const { data: partnerStats } = useQuery({
    queryKey: ['partnerStats'],
    queryFn: () => partnersService.getPartnerStats(),
  });

  const partners = partnersResponse?.data || [];
  const totalPartners = partnersResponse?.total || 0;
  const totalPages = Math.ceil(totalPartners / itemsPerPage);

  // Mutations
  const createPartnerMutation = useMutation({
    mutationFn: (data: CreatePartnerDTO) => partnersService.createPartner(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['partners'] });
      queryClient.invalidateQueries({ queryKey: ['partnerStats'] });
      setIsCreateDialogOpen(false);
      resetForm();
    },
  });

  const updatePartnerMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdatePartnerDTO }) =>
      partnersService.updatePartner(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['partners'] });
      queryClient.invalidateQueries({ queryKey: ['partnerStats'] });
      setIsEditDialogOpen(false);
      setSelectedPartner(null);
    },
  });

  const deletePartnerMutation = useMutation({
    mutationFn: (id: string) => partnersService.deletePartner(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['partners'] });
      queryClient.invalidateQueries({ queryKey: ['partnerStats'] });
      setIsDeleteDialogOpen(false);
      setPartnerToDelete(null);
    },
  });

  const approvePartnerMutation = useMutation({
    mutationFn: (id: string) => partnersService.approvePartner(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['partners'] });
      queryClient.invalidateQueries({ queryKey: ['partnerStats'] });
      setIsApproveDialogOpen(false);
      setPartnerToApprove(null);
    },
  });

  const rejectPartnerMutation = useMutation({
    mutationFn: (id: string) => partnersService.rejectPartner(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['partners'] });
      queryClient.invalidateQueries({ queryKey: ['partnerStats'] });
      setIsRejectDialogOpen(false);
      setPartnerToReject(null);
    },
  });

  const suspendPartnerMutation = useMutation({
    mutationFn: (id: string) => partnersService.suspendPartner(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['partners'] });
      queryClient.invalidateQueries({ queryKey: ['partnerStats'] });
      setIsSuspendDialogOpen(false);
      setPartnerToSuspend(null);
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
      referralCode: '',
      status: 'all',
      minEarnings: '',
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
      filters.referralCode ||
      filters.status !== 'all' ||
      filters.minEarnings ||
      filters.dateFrom ||
      filters.dateTo ||
      searchQuery
    );
  }, [filters, searchQuery]);

  // Export to Excel
  const handleExportToExcel = () => {
    const exportData = partners.map((partner) => ({
      ID: partner.id,
      'User ID': partner.userId,
      'Referral Code': partner.referralCode,
      'Commission Rate': `${partner.commissionRate}%`,
      'Total Earnings': partner.totalEarnings,
      'Paid Earnings': partner.paidEarnings,
      'Pending Earnings': partner.pendingEarnings,
      'Referral Count': partner.referralCount,
      Status: partner.status,
      'Payout Method': partner.payoutMethod || '-',
      'Created At': new Date(partner.createdAt).toLocaleString(),
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Partners');

    const colWidths = [
      { wch: 10 }, { wch: 15 }, { wch: 20 }, { wch: 15 },
      { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 12 },
      { wch: 12 }, { wch: 15 }, { wch: 20 },
    ];
    ws['!cols'] = colWidths;

    const timestamp = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `partners-export-${timestamp}.xlsx`);
  };

  // Form handlers
  const resetForm = () => {
    setFormData({
      userId: '',
      commissionRate: 10,
      payoutMethod: 'paypal',
      status: 'pending',
    });
  };

  const populateEditForm = (partner: Partner) => {
    setFormData({
      commissionRate: partner.commissionRate,
      payoutMethod: partner.payoutMethod || 'paypal',
      status: partner.status,
    });
  };

  const handleCreatePartner = () => {
    if (!formData.userId) return;
    createPartnerMutation.mutate(formData as CreatePartnerDTO);
  };

  const handleUpdatePartner = () => {
    if (!selectedPartner) return;
    updatePartnerMutation.mutate({
      id: selectedPartner.id,
      data: formData as UpdatePartnerDTO,
    });
  };

  // Action handlers
  const handleViewDetails = (partner: Partner) => {
    setSelectedPartner(partner);
    setIsDetailDialogOpen(true);
  };

  const handleEditClick = (partner: Partner) => {
    setSelectedPartner(partner);
    populateEditForm(partner);
    setIsEditDialogOpen(true);
  };

  const handleDeleteClick = (partner: Partner) => {
    setPartnerToDelete(partner);
    setIsDeleteDialogOpen(true);
  };

  const handleApproveClick = (partner: Partner) => {
    setPartnerToApprove(partner);
    setIsApproveDialogOpen(true);
  };

  const handleRejectClick = (partner: Partner) => {
    setPartnerToReject(partner);
    setIsRejectDialogOpen(true);
  };

  const handleSuspendClick = (partner: Partner) => {
    setPartnerToSuspend(partner);
    setIsSuspendDialogOpen(true);
  };

  const confirmDelete = () => {
    if (partnerToDelete) {
      deletePartnerMutation.mutate(partnerToDelete.id);
    }
  };

  const confirmApprove = () => {
    if (partnerToApprove) {
      approvePartnerMutation.mutate(partnerToApprove.id);
    }
  };

  const confirmReject = () => {
    if (partnerToReject) {
      rejectPartnerMutation.mutate(partnerToReject.id);
    }
  };

  const confirmSuspend = () => {
    if (partnerToSuspend) {
      suspendPartnerMutation.mutate(partnerToSuspend.id);
    }
  };

  // Helper functions
  const getStatusBadge = (status: PartnerStatus) => {
    switch (status) {
      case 'active':
        return (
          <Badge variant="default" className="bg-green-500">
            <CheckCircle className="mr-1 h-3 w-3" />
            Active
          </Badge>
        );
      case 'pending':
        return (
          <Badge variant="secondary">
            <Loader2 className="mr-1 h-3 w-3" />
            Pending
          </Badge>
        );
      case 'suspended':
        return (
          <Badge variant="destructive">
            <Ban className="mr-1 h-3 w-3" />
            Suspended
          </Badge>
        );
      case 'rejected':
        return (
          <Badge variant="outline" className="text-red-500">
            <XCircle className="mr-1 h-3 w-3" />
            Rejected
          </Badge>
        );
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
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
          <h1 className="text-3xl font-bold tracking-tight">Partners</h1>
          <p className="text-muted-foreground mt-1">
            Manage partner program and affiliate earnings
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExportToExcel}>
            <Download className="mr-2 h-4 w-4" />
            Export Excel
          </Button>
          <Button onClick={() => setIsCreateDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Partner
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Partners</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{partnerStats?.totalPartners || 0}</div>
            <p className="text-xs text-muted-foreground">
              {partners.length} showing on this page
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Partners</CardTitle>
            <UserCheck className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{partnerStats?.activePartners || 0}</div>
            <p className="text-xs text-muted-foreground">
              Earning commissions
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Earnings</CardTitle>
            <TrendingUp className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${(partnerStats?.totalEarnings || 0).toFixed(2)}</div>
            <p className="text-xs text-muted-foreground">
              All time earnings
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Payouts</CardTitle>
            <Wallet className="h-4 w-4 text-orange-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${(partnerStats?.totalPending || 0).toFixed(2)}</div>
            <p className="text-xs text-muted-foreground">
              Awaiting payment
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
              placeholder="Search by user ID or referral code..."
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
                    Partner ID
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
                    <Users className="h-3 w-3" />
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
                    value={filters.status}
                    onChange={(e) => handleFilterChange('status', e.target.value)}
                    className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="all">All Status</option>
                    <option value="pending">Pending</option>
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                    <option value="rejected">Rejected</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium flex items-center gap-1">
                    <DollarSign className="h-3 w-3" />
                    Min Earnings
                  </Label>
                  <Input
                    type="number"
                    placeholder="Min earnings..."
                    value={filters.minEarnings}
                    onChange={(e) => handleFilterChange('minEarnings', e.target.value)}
                    className="h-8"
                  />
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

      {/* Partners Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Partners</CardTitle>
          <CardDescription>
            Manage partners with filtering, sorting, and pagination
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
              <p>Failed to load partners</p>
              <p className="text-sm">{(error as Error)?.message}</p>
            </div>
          ) : partners.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Users className="mx-auto h-12 w-12 opacity-50 mb-4" />
              <p>No partners found</p>
              {hasActiveFilters && (
                <Button variant="link" onClick={clearFilters}>
                  Clear filters to see all partners
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('id')}>
                      <div className="flex items-center">ID {getSortIcon('id')}</div>
                    </TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('userId')}>
                      <div className="flex items-center">User ID {getSortIcon('userId')}</div>
                    </TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('referralCode')}>
                      <div className="flex items-center">Referral Code {getSortIcon('referralCode')}</div>
                    </TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('commissionRate')}>
                      <div className="flex items-center">Commission {getSortIcon('commissionRate')}</div>
                    </TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('totalEarnings')}>
                      <div className="flex items-center">Earnings {getSortIcon('totalEarnings')}</div>
                    </TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('status')}>
                      <div className="flex items-center">Status {getSortIcon('status')}</div>
                    </TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('createdAt')}>
                      <div className="flex items-center">Created {getSortIcon('createdAt')}</div>
                    </TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {partners.map((partner) => (
                    <TableRow key={partner.id}>
                      <TableCell className="font-mono text-xs">{partner.id}</TableCell>
                      <TableCell className="font-mono text-xs">{partner.userId}</TableCell>
                      <TableCell className="font-medium">{partner.referralCode}</TableCell>
                      <TableCell>
                        <div className="flex items-center">
                          <Percent className="h-3 w-3 mr-1 text-muted-foreground" />
                          {partner.commissionRate}%
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <div className="font-medium">${partner.totalEarnings.toFixed(2)}</div>
                          <div className="text-xs text-muted-foreground">
                            Pending: ${partner.pendingEarnings.toFixed(2)}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>{getStatusBadge(partner.status)}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(partner.createdAt).toLocaleDateString()}
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
                            <DropdownMenuItem onClick={() => handleViewDetails(partner)}>
                              <Eye className="mr-2 h-4 w-4" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleEditClick(partner)}>
                              <Edit className="mr-2 h-4 w-4" />
                              Edit Partner
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {partner.status === 'pending' && (
                              <>
                                <DropdownMenuItem onClick={() => handleApproveClick(partner)}>
                                  <CheckCircle className="mr-2 h-4 w-4 text-green-500" />
                                  <span className="text-green-600">Approve</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleRejectClick(partner)}>
                                  <XCircle className="mr-2 h-4 w-4 text-red-500" />
                                  <span className="text-red-600">Reject</span>
                                </DropdownMenuItem>
                              </>
                            )}
                            {partner.status === 'active' && (
                              <DropdownMenuItem onClick={() => handleSuspendClick(partner)}>
                                <Ban className="mr-2 h-4 w-4 text-orange-500" />
                                <span className="text-orange-600">Suspend</span>
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => handleDeleteClick(partner)} className="text-red-600">
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
          {!isLoading && !isError && partners.length > 0 && (
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
                  {Math.min(currentPage * itemsPerPage, totalPartners)} of {totalPartners} entries
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" onClick={goToFirstPage} disabled={currentPage === 1} className="h-8 w-8">
                  <ChevronsLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" onClick={goToPreviousPage} disabled={currentPage === 1} className="h-8 w-8">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm px-3">Page {currentPage} of {totalPages}</span>
                <Button variant="outline" size="icon" onClick={goToNextPage} disabled={currentPage === totalPages} className="h-8 w-8">
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" onClick={goToLastPage} disabled={currentPage === totalPages} className="h-8 w-8">
                  <ChevronsRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Partner Details Dialog */}
      <Dialog open={isDetailDialogOpen} onOpenChange={setIsDetailDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Partner Details</DialogTitle>
            <DialogDescription>Detailed information about partner</DialogDescription>
          </DialogHeader>
          {selectedPartner && (
            <div className="space-y-6 py-4">
              <div className="flex items-center gap-4">
                <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <Users className="h-8 w-8 text-primary" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">Partner #{selectedPartner.id}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    {getStatusBadge(selectedPartner.status)}
                  </div>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Partner ID</Label>
                  <p className="font-mono text-sm">{selectedPartner.id}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">User ID</Label>
                  <p className="font-mono text-sm">{selectedPartner.userId}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Referral Code</Label>
                  <p className="text-sm font-medium">{selectedPartner.referralCode}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Commission Rate</Label>
                  <p className="text-sm">{selectedPartner.commissionRate}%</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Total Earnings</Label>
                  <p className="text-sm font-medium">${selectedPartner.totalEarnings.toFixed(2)}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Referral Count</Label>
                  <p className="text-sm">{selectedPartner.referralCount}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Payout Method</Label>
                  <p className="text-sm capitalize">{selectedPartner.payoutMethod || 'Not set'}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Created At</Label>
                  <p className="text-sm">{new Date(selectedPartner.createdAt).toLocaleString()}</p>
                </div>
              </div>
              <div className="flex gap-2 pt-4 border-t">
                <Button variant="outline" onClick={() => { setIsDetailDialogOpen(false); handleEditClick(selectedPartner); }}>
                  <Edit className="mr-2 h-4 w-4" />
                  Edit Partner
                </Button>
                {selectedPartner.status === 'pending' && (
                  <>
                    <Button variant="outline" onClick={() => { setIsDetailDialogOpen(false); handleApproveClick(selectedPartner); }} className="text-green-600">
                      <CheckCircle className="mr-2 h-4 w-4" />
                      Approve
                    </Button>
                    <Button variant="outline" onClick={() => { setIsDetailDialogOpen(false); handleRejectClick(selectedPartner); }} className="text-red-600">
                      <XCircle className="mr-2 h-4 w-4" />
                      Reject
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Create Partner Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create New Partner</DialogTitle>
            <DialogDescription>Add a new partner to the program</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="userId">User ID <span className="text-red-500">*</span></Label>
              <Input id="userId" value={formData.userId} onChange={(e) => setFormData({ ...formData, userId: e.target.value })} placeholder="Enter user ID" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="commissionRate">Commission Rate (%)</Label>
              <Input id="commissionRate" type="number" value={formData.commissionRate} onChange={(e) => setFormData({ ...formData, commissionRate: Number(e.target.value) })} placeholder="10" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="payoutMethod">Payout Method</Label>
              <select id="payoutMethod" value={formData.payoutMethod} onChange={(e) => setFormData({ ...formData, payoutMethod: e.target.value as 'paypal' | 'bank_transfer' | 'crypto' | 'other' })} className="w-full rounded-md border border-input bg-background px-3 py-2">
                <option value="paypal">PayPal</option>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="crypto">Crypto</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleCreatePartner} disabled={!formData.userId || createPartnerMutation.isPending}>
              {createPartnerMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Partner
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Partner Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Partner</DialogTitle>
            <DialogDescription>Update partner information</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-commissionRate">Commission Rate (%)</Label>
              <Input id="edit-commissionRate" type="number" value={formData.commissionRate} onChange={(e) => setFormData({ ...formData, commissionRate: Number(e.target.value) })} placeholder="10" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-payoutMethod">Payout Method</Label>
              <select id="edit-payoutMethod" value={formData.payoutMethod} onChange={(e) => setFormData({ ...formData, payoutMethod: e.target.value as 'paypal' | 'bank_transfer' | 'crypto' | 'other' })} className="w-full rounded-md border border-input bg-background px-3 py-2">
                <option value="paypal">PayPal</option>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="crypto">Crypto</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-status">Status</Label>
              <select id="edit-status" value={formData.status} onChange={(e) => setFormData({ ...formData, status: e.target.value as PartnerStatus })} className="w-full rounded-md border border-input bg-background px-3 py-2">
                <option value="pending">Pending</option>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleUpdatePartner} disabled={updatePartnerMutation.isPending}>
              {updatePartnerMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Update Partner
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Partner</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete partner #{partnerToDelete?.id}? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive hover:bg-destructive/90" disabled={deletePartnerMutation.isPending}>
              {deletePartnerMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Approve Confirmation */}
      <AlertDialog open={isApproveDialogOpen} onOpenChange={setIsApproveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve Partner</AlertDialogTitle>
            <AlertDialogDescription>
              Approve partner #{partnerToApprove?.id}? They will be able to start earning commissions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmApprove} disabled={approvePartnerMutation.isPending}>
              {approvePartnerMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject Confirmation */}
      <AlertDialog open={isRejectDialogOpen} onOpenChange={setIsRejectDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject Partner</AlertDialogTitle>
            <AlertDialogDescription>
              Reject partner #{partnerToReject?.id}? They will not be able to participate in the program.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmReject} className="bg-destructive hover:bg-destructive/90" disabled={rejectPartnerMutation.isPending}>
              {rejectPartnerMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Suspend Confirmation */}
      <AlertDialog open={isSuspendDialogOpen} onOpenChange={setIsSuspendDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suspend Partner</AlertDialogTitle>
            <AlertDialogDescription>
              Suspend partner #{partnerToSuspend?.id}? They will not be able to earn new commissions until reactivated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmSuspend} className="bg-orange-500 hover:bg-orange-600" disabled={suspendPartnerMutation.isPending}>
              {suspendPartnerMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Suspend
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
