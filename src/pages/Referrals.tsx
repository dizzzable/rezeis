import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Users,
  Search,
  Filter,
  Download,
  Eye,
  CheckCircle,
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
  TrendingUp,
  Gift,
  Trophy,
  Calendar,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { referralsService } from '@/api/referrals.service';
import type {
  Referral,
  ReferralStatus,
} from '@/types/entity.types';
import * as XLSX from 'xlsx';

type SortField = 'id' | 'referrerId' | 'referredId' | 'status' | 'referrerReward' | 'createdAt';
type SortDirection = 'asc' | 'desc';

interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

interface FilterConfig {
  status: 'all' | ReferralStatus;
  referrerId: string;
  referredId: string;
  dateFrom: string;
  dateTo: string;
}

const ITEMS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

export default function Referrals(): React.ReactElement {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('referrals');
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);
  const [sortConfig, setSortConfig] = useState<SortConfig>({ field: 'createdAt', direction: 'desc' });
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<FilterConfig>({
    status: 'all',
    referrerId: '',
    referredId: '',
    dateFrom: '',
    dateTo: '',
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [, setSelectedReferral] = useState<Referral | null>(null);
  const [, setIsDetailDialogOpen] = useState(false);
  const [isCompleteDialogOpen, setIsCompleteDialogOpen] = useState(false);
  const [isCancelDialogOpen, setIsCancelDialogOpen] = useState(false);
  const [referralToAction, setReferralToAction] = useState<Referral | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  const { data: referralsResponse, isLoading, isError } = useQuery({
    queryKey: ['referrals', currentPage, itemsPerPage, searchQuery, filters, sortConfig],
    queryFn: () => referralsService.getReferrals({
      page: currentPage,
      limit: itemsPerPage,
      status: filters.status !== 'all' ? filters.status : undefined,
      referrerId: filters.referrerId || undefined,
      referredId: filters.referredId || undefined,
    }),
  });

  const { data: referralStats } = useQuery({
    queryKey: ['referralStats'],
    queryFn: () => referralsService.getReferralStatistics(),
  });

  const { data: topReferrers } = useQuery({
    queryKey: ['topReferrers'],
    queryFn: () => referralsService.getTopReferrers(),
  });

  const { data: referralRules } = useQuery({
    queryKey: ['referralRules'],
    queryFn: () => referralsService.getReferralRules(),
  });

  const referrals = referralsResponse?.data || [];
  const totalReferrals = referralsResponse?.total || 0;
  const totalPages = Math.ceil(totalReferrals / itemsPerPage);

  const completeReferralMutation = useMutation({
    mutationFn: (id: string) => referralsService.completeReferral(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['referrals'] });
      queryClient.invalidateQueries({ queryKey: ['referralStats'] });
      setIsCompleteDialogOpen(false);
      setReferralToAction(null);
    },
  });

  const cancelReferralMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => referralsService.cancelReferral(id, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['referrals'] });
      queryClient.invalidateQueries({ queryKey: ['referralStats'] });
      setIsCancelDialogOpen(false);
      setReferralToAction(null);
      setCancelReason('');
    },
  });

  const handleSort = (field: SortField) => {
    setSortConfig((current) => ({
      field,
      direction: current.field === field && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  const getSortIcon = (field: SortField) => {
    if (sortConfig.field !== field) return <ArrowUpDown className="ml-2 h-4 w-4 text-muted-foreground" />;
    return sortConfig.direction === 'asc' ? <ArrowUp className="ml-2 h-4 w-4" /> : <ArrowDown className="ml-2 h-4 w-4" />;
  };

  const clearFilters = () => {
    setFilters({ status: 'all', referrerId: '', referredId: '', dateFrom: '', dateTo: '' });
    setSearchQuery('');
    setCurrentPage(1);
  };

  const hasActiveFilters = useMemo(() =>
    filters.referrerId || filters.referredId || filters.status !== 'all' || filters.dateFrom || filters.dateTo || searchQuery,
    [filters, searchQuery]
  );

  const handleExportToExcel = () => {
    const exportData = referrals.map((r) => ({
      ID: r.id,
      Referrer: r.referrerId,
      Referred: r.referredId,
      Code: r.referralCode || '-',
      Status: r.status,
      'Referrer Reward': r.referrerReward,
      'Referred Reward': r.referredReward,
      'Created At': new Date(r.createdAt).toLocaleString(),
    }));
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Referrals');
    XLSX.writeFile(wb, `referrals-export-${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const getStatusBadge = (status: ReferralStatus) => {
    switch (status) {
      case 'active': return <Badge variant="secondary"><Loader2 className="mr-1 h-3 w-3 animate-spin" />Active</Badge>;
      case 'completed': return <Badge variant="default" className="bg-green-500"><CheckCircle className="mr-1 h-3 w-3" />Completed</Badge>;
      case 'cancelled': return <Badge variant="destructive"><XCircle className="mr-1 h-3 w-3" />Cancelled</Badge>;
      default: return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const confirmComplete = () => {
    if (referralToAction) completeReferralMutation.mutate(referralToAction.id);
  };

  const confirmCancel = () => {
    if (referralToAction) cancelReferralMutation.mutate({ id: referralToAction.id, reason: cancelReason });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Referrals</h1>
          <p className="text-muted-foreground mt-1">Manage referral system and rewards</p>
        </div>
        <Button variant="outline" onClick={handleExportToExcel}>
          <Download className="mr-2 h-4 w-4" />
          Export Excel
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Referrals</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{referralStats?.totalReferrals || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Completed</CardTitle>
            <CheckCircle className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{referralStats?.completedReferrals || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Rewards Paid</CardTitle>
            <TrendingUp className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${(referralStats?.totalRewardsPaid || 0).toFixed(2)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Rewards</CardTitle>
            <Gift className="h-4 w-4 text-orange-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${(referralStats?.pendingRewards || 0).toFixed(2)}</div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="referrals">Referrals</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="top">Top Referrers</TabsTrigger>
        </TabsList>

        <TabsContent value="referrals" className="space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search referrals..."
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
                className="pl-9"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setShowFilters(!showFilters)} className={showFilters ? 'bg-accent' : ''}>
                <Filter className="mr-2 h-4 w-4" />
                Filters
                {hasActiveFilters && <Badge variant="secondary" className="ml-2">Active</Badge>}
              </Button>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters}><X className="mr-1 h-4 w-4" />Clear</Button>
              )}
            </div>
          </div>

          {showFilters && (
            <Card className="bg-muted/50">
              <CardContent className="pt-6">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">Status</Label>
                    <select
                      value={filters.status}
                      onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as 'all' | ReferralStatus }))}
                      className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="all">All Status</option>
                      <option value="active">Active</option>
                      <option value="completed">Completed</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-medium flex items-center gap-1"><Calendar className="h-3 w-3" />From Date</Label>
                    <Input type="date" value={filters.dateFrom} onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))} className="h-8" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-medium flex items-center gap-1"><Calendar className="h-3 w-3" />To Date</Label>
                    <Input type="date" value={filters.dateTo} onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))} className="h-8" />
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>All Referrals</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
              ) : isError ? (
                <div className="text-center py-12 text-muted-foreground"><p>Failed to load referrals</p></div>
              ) : referrals.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground"><Users className="mx-auto h-12 w-12 opacity-50 mb-4" /><p>No referrals found</p></div>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="cursor-pointer" onClick={() => handleSort('id')}><div className="flex items-center">ID {getSortIcon('id')}</div></TableHead>
                        <TableHead className="cursor-pointer" onClick={() => handleSort('referrerId')}><div className="flex items-center">Referrer {getSortIcon('referrerId')}</div></TableHead>
                        <TableHead className="cursor-pointer" onClick={() => handleSort('referredId')}><div className="flex items-center">Referred {getSortIcon('referredId')}</div></TableHead>
                        <TableHead>Code</TableHead>
                        <TableHead className="cursor-pointer" onClick={() => handleSort('status')}><div className="flex items-center">Status {getSortIcon('status')}</div></TableHead>
                        <TableHead>Rewards</TableHead>
                        <TableHead className="w-[50px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {referrals.map((referral) => (
                        <TableRow key={referral.id}>
                          <TableCell className="font-mono text-xs">{referral.id}</TableCell>
                          <TableCell className="font-mono text-xs">{referral.referrerId}</TableCell>
                          <TableCell className="font-mono text-xs">{referral.referredId}</TableCell>
                          <TableCell>{referral.referralCode || '-'}</TableCell>
                          <TableCell>{getStatusBadge(referral.status)}</TableCell>
                          <TableCell className="text-sm">${referral.referrerReward} / ${referral.referredReward}</TableCell>
                          <TableCell>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => { setSelectedReferral(referral); setIsDetailDialogOpen(true); }}>
                                  <Eye className="mr-2 h-4 w-4" />View Details
                                </DropdownMenuItem>
                                {referral.status === 'active' && (
                                  <>
                                    <DropdownMenuItem onClick={() => { setReferralToAction(referral); setIsCompleteDialogOpen(true); }}>
                                      <CheckCircle className="mr-2 h-4 w-4 text-green-500" /><span className="text-green-600">Complete</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => { setReferralToAction(referral); setIsCancelDialogOpen(true); }}>
                                      <XCircle className="mr-2 h-4 w-4 text-red-500" /><span className="text-red-600">Cancel</span>
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <div className="flex items-center justify-between mt-6">
                    <div className="flex items-center gap-4">
                      <select
                        value={itemsPerPage}
                        onChange={(e) => { setItemsPerPage(Number(e.target.value)); setCurrentPage(1); }}
                        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                      >
                        {ITEMS_PER_PAGE_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                      <span className="text-sm text-muted-foreground">Showing {((currentPage - 1) * itemsPerPage) + 1} to {Math.min(currentPage * itemsPerPage, totalReferrals)} of {totalReferrals}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="outline" size="icon" onClick={() => setCurrentPage(1)} disabled={currentPage === 1} className="h-8 w-8"><ChevronsLeft className="h-4 w-4" /></Button>
                      <Button variant="outline" size="icon" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1} className="h-8 w-8"><ChevronLeft className="h-4 w-4" /></Button>
                      <span className="text-sm px-3">Page {currentPage} of {totalPages}</span>
                      <Button variant="outline" size="icon" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="h-8 w-8"><ChevronRight className="h-4 w-4" /></Button>
                      <Button variant="outline" size="icon" onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages} className="h-8 w-8"><ChevronsRight className="h-4 w-4" /></Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules">
          <Card>
            <CardHeader>
              <CardTitle>Referral Rules</CardTitle>
              <CardDescription>Configure referral reward rules and conditions</CardDescription>
            </CardHeader>
            <CardContent>
              {referralRules?.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground"><Gift className="mx-auto h-12 w-12 opacity-50 mb-4" /><p>No referral rules configured</p></div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Referrer Reward</TableHead>
                      <TableHead>Referred Reward</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {referralRules?.map((rule) => (
                      <TableRow key={rule.id}>
                        <TableCell className="font-medium">{rule.name}</TableCell>
                        <TableCell><Badge variant="secondary">{rule.type}</Badge></TableCell>
                        <TableCell>${rule.referrerReward}</TableCell>
                        <TableCell>${rule.referredReward}</TableCell>
                        <TableCell>{rule.isActive ? <Badge className="bg-green-500">Active</Badge> : <Badge variant="outline">Inactive</Badge>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="top">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Trophy className="h-5 w-5 text-yellow-500" />
                Top Referrers
              </CardTitle>
              <CardDescription>Users with the most successful referrals</CardDescription>
            </CardHeader>
            <CardContent>
              {!topReferrers || topReferrers.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground"><Trophy className="mx-auto h-12 w-12 opacity-50 mb-4" /><p>No top referrers yet</p></div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[80px]">Rank</TableHead>
                      <TableHead>User ID</TableHead>
                      <TableHead>Referral Count</TableHead>
                      <TableHead>Total Rewards</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topReferrers.map((referrer, index) => (
                      <TableRow key={referrer.userId}>
                        <TableCell>
                          {index === 0 ? <Trophy className="h-5 w-5 text-yellow-500" /> :
                           index === 1 ? <Trophy className="h-5 w-5 text-gray-400" /> :
                           index === 2 ? <Trophy className="h-5 w-5 text-amber-600" /> :
                           <span className="text-muted-foreground">#{index + 1}</span>}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{referrer.userId}</TableCell>
                        <TableCell className="font-medium">{referrer.referralCount}</TableCell>
                        <TableCell>${referrer.totalRewards.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Complete Dialog */}
      <AlertDialog open={isCompleteDialogOpen} onOpenChange={setIsCompleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Complete Referral</AlertDialogTitle>
            <AlertDialogDescription>Mark this referral as completed? Rewards will be processed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmComplete} disabled={completeReferralMutation.isPending}>
              {completeReferralMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Complete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel Dialog */}
      <Dialog open={isCancelDialogOpen} onOpenChange={setIsCancelDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Referral</DialogTitle>
            <DialogDescription>Provide a reason for cancelling this referral.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="cancelReason">Reason (optional)</Label>
              <Input id="cancelReason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Enter cancellation reason..." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCancelDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmCancel} disabled={cancelReferralMutation.isPending}>
              {cancelReferralMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
