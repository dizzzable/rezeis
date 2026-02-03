import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Package,
  Search,
  Plus,
  Filter,
  Download,
  Eye,
  Edit,
  Trash2,
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
  Hash,
  DollarSign,
  Clock,
  ToggleLeft,
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
import { plansService } from '@/api/plans.service';
import type { Plan, CreatePlanDTO, UpdatePlanDTO } from '@/types/entity.types';
import * as XLSX from 'xlsx';

// Types for sorting and filtering
type SortField = 'id' | 'name' | 'price' | 'durationDays' | 'isActive' | 'createdAt';
type SortDirection = 'asc' | 'desc';

interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

interface FilterConfig {
  id: string;
  name: string;
  priceMin: string;
  priceMax: string;
  isActive: 'all' | 'active' | 'inactive';
}

const ITEMS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

/**
 * Plans page component with advanced features
 * Features: filtering, sorting, pagination, export, detail view, quick actions, bulk actions
 */
export default function Plans(): React.ReactElement {
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
    name: '',
    priceMin: '',
    priceMax: '',
    isActive: 'all',
  });

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  // Dialog states
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null);
  const [isDetailDialogOpen, setIsDetailDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [planToDelete, setPlanToDelete] = useState<Plan | null>(null);

  // Form states
  const [formData, setFormData] = useState<Partial<CreatePlanDTO & UpdatePlanDTO>>({
    name: '',
    description: '',
    price: 0,
    durationDays: 30,
    trafficLimit: 0,
    isActive: true,
  });

  // Fetch plans
  const {
    data: plans = [],
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['plans'],
    queryFn: () => plansService.getPlans(),
  });

  // Filter and sort plans client-side
  const filteredPlans = useMemo(() => {
    let result = [...plans];

    // Apply search
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (plan) =>
          plan.name.toLowerCase().includes(query) ||
          plan.description?.toLowerCase().includes(query) ||
          plan.id.toLowerCase().includes(query)
      );
    }

    // Apply filters
    if (filters.id) {
      result = result.filter((plan) => plan.id.toLowerCase().includes(filters.id.toLowerCase()));
    }
    if (filters.name) {
      result = result.filter((plan) => plan.name.toLowerCase().includes(filters.name.toLowerCase()));
    }
    if (filters.priceMin) {
      result = result.filter((plan) => plan.price >= Number(filters.priceMin));
    }
    if (filters.priceMax) {
      result = result.filter((plan) => plan.price <= Number(filters.priceMax));
    }
    if (filters.isActive !== 'all') {
      result = result.filter((plan) => plan.isActive === (filters.isActive === 'active'));
    }

    // Apply sorting
    result.sort((a, b) => {
      let aValue: string | number | boolean;
      let bValue: string | number | boolean;

      switch (sortConfig.field) {
        case 'id':
          aValue = a.id;
          bValue = b.id;
          break;
        case 'name':
          aValue = a.name;
          bValue = b.name;
          break;
        case 'price':
          aValue = a.price;
          bValue = b.price;
          break;
        case 'durationDays':
          aValue = a.durationDays;
          bValue = b.durationDays;
          break;
        case 'isActive':
          aValue = a.isActive;
          bValue = b.isActive;
          break;
        case 'createdAt':
          aValue = a.createdAt;
          bValue = b.createdAt;
          break;
        default:
          return 0;
      }

      if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [plans, searchQuery, filters, sortConfig]);

  // Pagination
  const totalPlans = filteredPlans.length;
  const totalPages = Math.ceil(totalPlans / itemsPerPage);
  const paginatedPlans = filteredPlans.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  // Mutations
  const createPlanMutation = useMutation({
    mutationFn: (data: CreatePlanDTO) => plansService.createPlan(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      setIsCreateDialogOpen(false);
      resetForm();
    },
  });

  const updatePlanMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdatePlanDTO }) => plansService.updatePlan(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      setIsEditDialogOpen(false);
      setSelectedPlan(null);
    },
  });

  const deletePlanMutation = useMutation({
    mutationFn: (id: string) => plansService.deletePlan(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      setIsDeleteDialogOpen(false);
      setPlanToDelete(null);
    },
  });

  const togglePlanMutation = useMutation({
    mutationFn: (id: string) => plansService.togglePlan(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
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
      name: '',
      priceMin: '',
      priceMax: '',
      isActive: 'all',
    });
    setSearchQuery('');
    setCurrentPage(1);
  };

  const hasActiveFilters = useMemo(() => {
    return (
      filters.id ||
      filters.name ||
      filters.priceMin ||
      filters.priceMax ||
      filters.isActive !== 'all' ||
      searchQuery
    );
  }, [filters, searchQuery]);

  // Export to Excel
  const handleExportToExcel = () => {
    const exportData = filteredPlans.map((plan) => ({
      ID: plan.id,
      Name: plan.name,
      Description: plan.description || '-',
      Price: plan.price,
      'Duration (Days)': plan.durationDays,
      'Traffic Limit': plan.trafficLimit || 'Unlimited',
      Status: plan.isActive ? 'Active' : 'Inactive',
      'Created At': new Date(plan.createdAt).toLocaleString(),
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Plans');

    const colWidths = [
      { wch: 10 },
      { wch: 20 },
      { wch: 30 },
      { wch: 10 },
      { wch: 15 },
      { wch: 15 },
      { wch: 10 },
      { wch: 20 },
    ];
    ws['!cols'] = colWidths;

    const timestamp = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `plans-export-${timestamp}.xlsx`);
  };

  // Form handlers
  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      price: 0,
      durationDays: 30,
      trafficLimit: 0,
      isActive: true,
    });
  };

  const populateEditForm = (plan: Plan) => {
    setFormData({
      name: plan.name,
      description: plan.description || '',
      price: plan.price,
      durationDays: plan.durationDays,
      trafficLimit: plan.trafficLimit,
      isActive: plan.isActive,
    });
  };

  const handleCreatePlan = () => {
    if (!formData.name || formData.price === undefined || formData.durationDays === undefined) return;
    createPlanMutation.mutate(formData as CreatePlanDTO);
  };

  const handleUpdatePlan = () => {
    if (!selectedPlan || !formData.name) return;
    updatePlanMutation.mutate({
      id: selectedPlan.id,
      data: formData as UpdatePlanDTO,
    });
  };

  // Action handlers
  const handleViewDetails = (plan: Plan) => {
    setSelectedPlan(plan);
    setIsDetailDialogOpen(true);
  };

  const handleEditClick = (plan: Plan) => {
    setSelectedPlan(plan);
    populateEditForm(plan);
    setIsEditDialogOpen(true);
  };

  const handleDeleteClick = (plan: Plan) => {
    setPlanToDelete(plan);
    setIsDeleteDialogOpen(true);
  };

  const handleToggleClick = (plan: Plan) => {
    togglePlanMutation.mutate(plan.id);
  };

  const confirmDelete = () => {
    if (planToDelete) {
      deletePlanMutation.mutate(planToDelete.id);
    }
  };

  // Helper functions
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
      <Badge variant="secondary">
        <XCircle className="mr-1 h-3 w-3" />
        Inactive
      </Badge>
    );
  };

  // Stats
  const activeCount = plans.filter((p) => p.isActive).length;
  const inactiveCount = plans.filter((p) => !p.isActive).length;
  const avgPrice = plans.length > 0 ? plans.reduce((sum, p) => sum + p.price, 0) / plans.length : 0;

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
          <h1 className="text-3xl font-bold tracking-tight">Plans</h1>
          <p className="text-muted-foreground mt-1">Manage VPN subscription plans and pricing</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExportToExcel}>
            <Download className="mr-2 h-4 w-4" />
            Export Excel
          </Button>
          <Button onClick={() => setIsCreateDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Create Plan
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Plans</CardTitle>
            <Package className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalPlans.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">{paginatedPlans.length} showing on this page</p>
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
              {totalPlans > 0 ? Math.round((activeCount / totalPlans) * 100) : 0}% of total
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Inactive</CardTitle>
            <Badge variant="secondary">Inactive</Badge>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{inactiveCount}</div>
            <p className="text-xs text-muted-foreground">
              {totalPlans > 0 ? Math.round((inactiveCount / totalPlans) * 100) : 0}% of total
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Average Price</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${avgPrice.toFixed(2)}</div>
            <p className="text-xs text-muted-foreground">Across all plans</p>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filters */}
      <div className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name or description..."
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
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <div className="space-y-2">
                  <Label className="text-xs font-medium flex items-center gap-1">
                    <Hash className="h-3 w-3" />
                    Plan ID
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
                    <Package className="h-3 w-3" />
                    Name
                  </Label>
                  <Input
                    placeholder="Filter by name..."
                    value={filters.name}
                    onChange={(e) => handleFilterChange('name', e.target.value)}
                    className="h-8"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Min Price</Label>
                  <Input
                    type="number"
                    placeholder="Min price..."
                    value={filters.priceMin}
                    onChange={(e) => handleFilterChange('priceMin', e.target.value)}
                    className="h-8"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Max Price</Label>
                  <Input
                    type="number"
                    placeholder="Max price..."
                    value={filters.priceMax}
                    onChange={(e) => handleFilterChange('priceMax', e.target.value)}
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

      {/* Plans Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Plans</CardTitle>
          <CardDescription>Manage subscription plans with filtering, sorting, and pagination</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <div className="text-center py-12 text-muted-foreground">
              <XCircle className="mx-auto h-12 w-12 mb-4" />
              <p>Failed to load plans</p>
              <p className="text-sm">{(error as Error)?.message}</p>
            </div>
          ) : paginatedPlans.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Package className="mx-auto h-12 w-12 opacity-50 mb-4" />
              <p>No plans found</p>
              {hasActiveFilters && (
                <Button variant="link" onClick={clearFilters}>
                  Clear filters to see all plans
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
                    <TableHead>Description</TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('price')}>
                      <div className="flex items-center">
                        Price
                        {getSortIcon('price')}
                      </div>
                    </TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('durationDays')}>
                      <div className="flex items-center">
                        Duration
                        {getSortIcon('durationDays')}
                      </div>
                    </TableHead>
                    <TableHead>Traffic</TableHead>
                    <TableHead className="cursor-pointer" onClick={() => handleSort('isActive')}>
                      <div className="flex items-center">
                        Status
                        {getSortIcon('isActive')}
                      </div>
                    </TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedPlans.map((plan) => (
                    <TableRow key={plan.id}>
                      <TableCell className="font-mono text-xs">{plan.id}</TableCell>
                      <TableCell className="font-medium">{plan.name}</TableCell>
                      <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">
                        {plan.description || '-'}
                      </TableCell>
                      <TableCell className="font-medium">${plan.price.toFixed(2)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Clock className="h-3 w-3 text-muted-foreground" />
                          {plan.durationDays} days
                        </div>
                      </TableCell>
                      <TableCell>{plan.trafficLimit ? `${plan.trafficLimit} GB` : 'Unlimited'}</TableCell>
                      <TableCell>{getStatusBadge(plan.isActive)}</TableCell>
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
                            <DropdownMenuItem onClick={() => handleViewDetails(plan)}>
                              <Eye className="mr-2 h-4 w-4" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleEditClick(plan)}>
                              <Edit className="mr-2 h-4 w-4" />
                              Edit Plan
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => handleToggleClick(plan)}
                              disabled={togglePlanMutation.isPending}
                            >
                              <ToggleLeft className="mr-2 h-4 w-4" />
                              {plan.isActive ? 'Deactivate' : 'Activate'}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => handleDeleteClick(plan)} className="text-red-600">
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
          {!isLoading && !isError && paginatedPlans.length > 0 && (
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
                  {Math.min(currentPage * itemsPerPage, totalPlans)} of {totalPlans} entries
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

      {/* Plan Details Dialog */}
      <Dialog open={isDetailDialogOpen} onOpenChange={setIsDetailDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Plan Details</DialogTitle>
            <DialogDescription>Detailed information about {selectedPlan?.name}</DialogDescription>
          </DialogHeader>
          {selectedPlan && (
            <div className="space-y-6 py-4">
              {/* Plan Header */}
              <div className="flex items-center gap-4">
                <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <Package className="h-8 w-8 text-primary" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">{selectedPlan.name}</h3>
                  <div className="flex items-center gap-2 mt-1">{getStatusBadge(selectedPlan.isActive)}</div>
                </div>
              </div>

              {/* Plan Info Grid */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Plan ID</Label>
                  <p className="font-mono text-sm">{selectedPlan.id}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Price</Label>
                  <p className="text-lg font-semibold">${selectedPlan.price.toFixed(2)}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Duration</Label>
                  <p className="text-sm">{selectedPlan.durationDays} days</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Traffic Limit</Label>
                  <p className="text-sm">{selectedPlan.trafficLimit ? `${selectedPlan.trafficLimit} GB` : 'Unlimited'}</p>
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">Description</Label>
                  <p className="text-sm">{selectedPlan.description || '-'}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Created At</Label>
                  <p className="text-sm">{new Date(selectedPlan.createdAt).toLocaleString()}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Updated At</Label>
                  <p className="text-sm">{new Date(selectedPlan.updatedAt).toLocaleString()}</p>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-4 border-t">
                <Button
                  variant="outline"
                  onClick={() => {
                    setIsDetailDialogOpen(false);
                    handleEditClick(selectedPlan);
                  }}
                >
                  <Edit className="mr-2 h-4 w-4" />
                  Edit Plan
                </Button>
                <Button variant="outline" onClick={() => handleToggleClick(selectedPlan)}>
                  <ToggleLeft className="mr-2 h-4 w-4" />
                  {selectedPlan.isActive ? 'Deactivate' : 'Activate'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Create Plan Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create New Plan</DialogTitle>
            <DialogDescription>Add a new subscription plan</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">
                Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Enter plan name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Enter plan description"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="price">
                  Price ($) <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="price"
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.price}
                  onChange={(e) => setFormData({ ...formData, price: Number(e.target.value) })}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="durationDays">
                  Duration (Days) <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="durationDays"
                  type="number"
                  min="1"
                  value={formData.durationDays}
                  onChange={(e) => setFormData({ ...formData, durationDays: Number(e.target.value) })}
                  placeholder="30"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="trafficLimit">Traffic Limit (GB)</Label>
              <Input
                id="trafficLimit"
                type="number"
                min="0"
                value={formData.trafficLimit}
                onChange={(e) =>
                  setFormData({ ...formData, trafficLimit: Number(e.target.value) || undefined })
                }
                placeholder="0 for unlimited"
              />
            </div>
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
              onClick={handleCreatePlan}
              disabled={!formData.name || formData.price === undefined || createPlanMutation.isPending}
            >
              {createPlanMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Plan Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Plan</DialogTitle>
            <DialogDescription>Update plan information</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">
                Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="edit-name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Enter plan name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">Description</Label>
              <Input
                id="edit-description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Enter plan description"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-price">
                  Price ($) <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="edit-price"
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.price}
                  onChange={(e) => setFormData({ ...formData, price: Number(e.target.value) })}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-durationDays">
                  Duration (Days) <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="edit-durationDays"
                  type="number"
                  min="1"
                  value={formData.durationDays}
                  onChange={(e) => setFormData({ ...formData, durationDays: Number(e.target.value) })}
                  placeholder="30"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-trafficLimit">Traffic Limit (GB)</Label>
              <Input
                id="edit-trafficLimit"
                type="number"
                min="0"
                value={formData.trafficLimit}
                onChange={(e) =>
                  setFormData({ ...formData, trafficLimit: Number(e.target.value) || undefined })
                }
                placeholder="0 for unlimited"
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="edit-isActive"
                checked={formData.isActive}
                onCheckedChange={(checked) => setFormData({ ...formData, isActive: checked })}
              />
              <Label htmlFor="edit-isActive">Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleUpdatePlan}
              disabled={!formData.name || formData.price === undefined || updatePlanMutation.isPending}
            >
              {updatePlanMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Update Plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Plan</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the plan "{planToDelete?.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive hover:bg-destructive/90"
              disabled={deletePlanMutation.isPending}
            >
              {deletePlanMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
