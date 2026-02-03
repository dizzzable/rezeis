import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Image,
  Plus,
  Edit,
  Trash2,
  Loader2,
  Eye,
  MousePointer,
  BarChart3,
  CheckCircle,
  Search,
  Layout,
  ArrowUpDown,
  Calendar,
  Link,
  Palette,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { bannersService } from '@/api/banners.service';
import type { Banner, BannerPosition } from '@/types/entity.types';

const POSITION_OPTIONS: { value: BannerPosition; label: string; color: string }[] = [
  { value: 'home_top', label: 'Home Top', color: 'bg-blue-500' },
  { value: 'home_bottom', label: 'Home Bottom', color: 'bg-green-500' },
  { value: 'plans_page', label: 'Plans Page', color: 'bg-purple-500' },
  { value: 'sidebar', label: 'Sidebar', color: 'bg-orange-500' },
];


export default function BannersPage(): React.ReactElement {
  const { t } = useTranslation('admin');
  const queryClient = useQueryClient();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isStatsDialogOpen, setIsStatsDialogOpen] = useState(false);
  const [editingBanner, setEditingBanner] = useState<Banner | null>(null);
  const [deletingBanner, setDeletingBanner] = useState<Banner | null>(null);
  const [viewingStatsBanner, setViewingStatsBanner] = useState<Banner | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [positionFilter, setPositionFilter] = useState<BannerPosition | 'all'>('all');

  // Form state
  const [formTitle, setFormTitle] = useState('');
  const [formSubtitle, setFormSubtitle] = useState('');
  const [formImageUrl, setFormImageUrl] = useState('');
  const [formLinkUrl, setFormLinkUrl] = useState('');
  const [formPosition, setFormPosition] = useState<BannerPosition>('home_top');
  const [formDisplayOrder, setFormDisplayOrder] = useState('0');
  const [formIsActive, setFormIsActive] = useState(true);
  const [formStartsAt, setFormStartsAt] = useState('');
  const [formEndsAt, setFormEndsAt] = useState('');
  const [formBackgroundColor, setFormBackgroundColor] = useState('');
  const [formTextColor, setFormTextColor] = useState('');

  const { data: bannersResponse, isLoading } = useQuery({
    queryKey: ['banners', positionFilter],
    queryFn: () => bannersService.getAll({
      page: 1,
      limit: 100,
      ...(positionFilter !== 'all' && { position: positionFilter }),
    }),
  });

  const { data: bannerStats, isLoading: isStatsLoading } = useQuery({
    queryKey: ['banner-stats', viewingStatsBanner?.id],
    queryFn: () => bannersService.getStatistics(viewingStatsBanner!.id),
    enabled: !!viewingStatsBanner && isStatsDialogOpen,
  });

  const banners = bannersResponse?.data || [];

  const filteredBanners = useMemo(() => {
    if (!searchQuery) return banners;
    return banners.filter(
      (banner) =>
        banner.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        banner.subtitle?.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [banners, searchQuery]);

  const createMutation = useMutation({
    mutationFn: bannersService.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['banners'] });
      setIsCreateDialogOpen(false);
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof bannersService.update>[1] }) =>
      bannersService.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['banners'] });
      setIsEditDialogOpen(false);
      setEditingBanner(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: bannersService.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['banners'] });
      setDeletingBanner(null);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: bannersService.toggleActive,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['banners'] });
    },
  });

  const resetForm = () => {
    setFormTitle('');
    setFormSubtitle('');
    setFormImageUrl('');
    setFormLinkUrl('');
    setFormPosition('home_top');
    setFormDisplayOrder('0');
    setFormIsActive(true);
    setFormStartsAt('');
    setFormEndsAt('');
    setFormBackgroundColor('');
    setFormTextColor('');
  };

  const populateEditForm = (banner: Banner) => {
    setFormTitle(banner.title);
    setFormSubtitle(banner.subtitle || '');
    setFormImageUrl(banner.imageUrl);
    setFormLinkUrl(banner.linkUrl || '');
    setFormPosition(banner.position);
    setFormDisplayOrder(banner.displayOrder.toString());
    setFormIsActive(banner.isActive);
    setFormStartsAt(banner.startsAt ? new Date(banner.startsAt).toISOString().slice(0, 16) : '');
    setFormEndsAt(banner.endsAt ? new Date(banner.endsAt).toISOString().slice(0, 16) : '');
    setFormBackgroundColor(banner.backgroundColor || '');
    setFormTextColor(banner.textColor || '');
  };

  const handleCreate = () => {
    createMutation.mutate({
      title: formTitle,
      subtitle: formSubtitle || undefined,
      imageUrl: formImageUrl,
      linkUrl: formLinkUrl || undefined,
      position: formPosition,
      displayOrder: parseInt(formDisplayOrder) || 0,
      isActive: formIsActive,
      startsAt: formStartsAt || undefined,
      endsAt: formEndsAt || undefined,
      backgroundColor: formBackgroundColor || undefined,
      textColor: formTextColor || undefined,
    });
  };

  const handleUpdate = () => {
    if (!editingBanner) return;
    updateMutation.mutate({
      id: editingBanner.id,
      data: {
        title: formTitle,
        subtitle: formSubtitle || undefined,
        imageUrl: formImageUrl,
        linkUrl: formLinkUrl || undefined,
        position: formPosition,
        displayOrder: parseInt(formDisplayOrder) || 0,
        isActive: formIsActive,
        startsAt: formStartsAt || undefined,
        endsAt: formEndsAt || undefined,
        backgroundColor: formBackgroundColor || undefined,
        textColor: formTextColor || undefined,
      },
    });
  };

  const handleEditClick = (banner: Banner) => {
    setEditingBanner(banner);
    populateEditForm(banner);
    setIsEditDialogOpen(true);
  };

  const handleDeleteClick = (banner: Banner) => {
    setDeletingBanner(banner);
  };

  const handleStatsClick = (banner: Banner) => {
    setViewingStatsBanner(banner);
    setIsStatsDialogOpen(true);
  };

  const confirmDelete = () => {
    if (deletingBanner) {
      deleteMutation.mutate(deletingBanner.id);
    }
  };

  const isFormValid = () => {
    return formTitle.trim() && formImageUrl.trim();
  };

  const calculateCTR = (clicks: number, impressions: number): string => {
    if (impressions === 0) return '0.00';
    return ((clicks / impressions) * 100).toFixed(2);
  };

  const getPositionBadge = (position: BannerPosition) => {
    const option = POSITION_OPTIONS.find((opt) => opt.value === position);
    return (
      <Badge className={option?.color || 'bg-gray-500'}>
        {option?.label || position}
      </Badge>
    );
  };

  const isExpired = (banner: Banner): boolean => {
    if (!banner.endsAt) return false;
    return new Date(banner.endsAt) < new Date();
  };

  const isScheduled = (banner: Banner): boolean => {
    if (!banner.startsAt) return false;
    return new Date(banner.startsAt) > new Date();
  };

  const getBannerStatus = (banner: Banner): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } => {
    if (!banner.isActive) return { label: 'Inactive', variant: 'secondary' };
    if (isExpired(banner)) return { label: 'Expired', variant: 'destructive' };
    if (isScheduled(banner)) return { label: 'Scheduled', variant: 'outline' };
    return { label: 'Active', variant: 'default' };
  };

  // Stats
  const totalBanners = banners.length;
  const activeBanners = banners.filter((b) => b.isActive && !isExpired(b)).length;
  const totalClicks = banners.reduce((sum, b) => sum + b.clickCount, 0);
  const totalImpressions = banners.reduce((sum, b) => sum + b.impressionCount, 0);
  const averageCTR = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('banners:title')}</h1>
          <p className="text-muted-foreground mt-1">
            {t('banners:description')}
          </p>
        </div>
        <Button onClick={() => setIsCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t('banners:create')}
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('banners:stats.totalBanners')}</CardTitle>
            <Image className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalBanners}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('banners:stats.active')}</CardTitle>
            <CheckCircle className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeBanners}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('banners:stats.totalClicks')}</CardTitle>
            <MousePointer className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalClicks.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('banners:stats.avgCTR')}</CardTitle>
            <BarChart3 className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{averageCTR.toFixed(2)}%</div>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filter */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('banners:searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <Layout className="h-4 w-4 text-muted-foreground" />
          <select
            value={positionFilter}
            onChange={(e) => setPositionFilter(e.target.value as BannerPosition | 'all')}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="all">{t('banners:allPositions')}</option>
            <option value="home_top">{t('banners:positions.home_top')}</option>
            <option value="home_bottom">{t('banners:positions.home_bottom')}</option>
            <option value="plans_page">{t('banners:positions.plans_page')}</option>
            <option value="sidebar">{t('banners:positions.sidebar')}</option>
          </select>
        </div>
      </div>

      {/* Banners Table */}
      <Card>
        <CardHeader>
          <CardTitle>{t('banners:allBanners')}</CardTitle>
          <CardDescription>{t('banners:manageDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Preview</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Position</TableHead>
                    <TableHead>Schedule</TableHead>
                    <TableHead>Clicks</TableHead>
                    <TableHead>Impressions</TableHead>
                    <TableHead>CTR</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredBanners.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                        {searchQuery || positionFilter !== 'all'
                          ? 'No banners found matching your filters.'
                          : 'No banners yet. Create your first banner to get started.'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredBanners.map((banner) => {
                      const status = getBannerStatus(banner);
                      return (
                        <TableRow key={banner.id}>
                          <TableCell>
                            <div className="h-12 w-20 rounded-md overflow-hidden border bg-muted">
                              {banner.imageUrl ? (
                                <img
                                  src={banner.imageUrl}
                                  alt={banner.title}
                                  className="h-full w-full object-cover"
                                  onError={(e) => {
                                    (e.target as HTMLImageElement).src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="40" height="24" fill="%23999"%3E%3Crect width="40" height="24" fill="%23f0f0f0"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" font-size="8" fill="%23999"%3ENo Image%3C/text%3E%3C/svg%3E';
                                  }}
                                />
                              ) : (
                                <div className="h-full w-full flex items-center justify-center bg-muted">
                                  <Image className="h-4 w-4 text-muted-foreground" />
                                </div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium">{banner.title}</div>
                            {banner.subtitle && (
                              <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                                {banner.subtitle}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>{getPositionBadge(banner.position)}</TableCell>
                          <TableCell>
                            {banner.startsAt || banner.endsAt ? (
                              <div className="text-xs">
                                {banner.startsAt && (
                                  <div className="flex items-center gap-1 text-muted-foreground">
                                    <Calendar className="h-3 w-3" />
                                    From: {new Date(banner.startsAt).toLocaleDateString()}
                                  </div>
                                )}
                                {banner.endsAt && (
                                  <div className="flex items-center gap-1 text-muted-foreground">
                                    <Calendar className="h-3 w-3" />
                                    To: {new Date(banner.endsAt).toLocaleDateString()}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">Always</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <MousePointer className="h-3 w-3 text-muted-foreground" />
                              <span>{banner.clickCount.toLocaleString()}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Eye className="h-3 w-3 text-muted-foreground" />
                              <span>{banner.impressionCount.toLocaleString()}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="font-medium">
                              {calculateCTR(banner.clickCount, banner.impressionCount)}%
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={banner.isActive}
                                onCheckedChange={() => toggleMutation.mutate(banner.id)}
                                disabled={toggleMutation.isPending}
                              />
                              <Badge variant={status.variant}>{status.label}</Badge>
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleStatsClick(banner)}
                                title="View Statistics"
                              >
                                <BarChart3 className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleEditClick(banner)}
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDeleteClick(banner)}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create New Banner</DialogTitle>
            <DialogDescription>
              Create a new advertising banner for your application
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Title */}
            <div className="space-y-2">
              <Label htmlFor="title">
                Title <span className="text-red-500">*</span>
              </Label>
              <Input
                id="title"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="Summer Sale 2025"
              />
            </div>

            {/* Subtitle */}
            <div className="space-y-2">
              <Label htmlFor="subtitle">Subtitle</Label>
              <Input
                id="subtitle"
                value={formSubtitle}
                onChange={(e) => setFormSubtitle(e.target.value)}
                placeholder="Get 50% off all plans"
              />
            </div>

            {/* Image URL */}
            <div className="space-y-2">
              <Label htmlFor="imageUrl">
                Image URL <span className="text-red-500">*</span>
              </Label>
              <Input
                id="imageUrl"
                value={formImageUrl}
                onChange={(e) => setFormImageUrl(e.target.value)}
                placeholder="https://example.com/banner.jpg"
              />
              {formImageUrl && (
                <div className="mt-2 h-32 w-full rounded-md overflow-hidden border bg-muted">
                  <img
                    src={formImageUrl}
                    alt="Banner preview"
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </div>
              )}
            </div>

            {/* Link URL */}
            <div className="space-y-2">
              <Label htmlFor="linkUrl">
                <div className="flex items-center gap-1">
                  <Link className="h-3 w-3" />
                  Link URL
                </div>
              </Label>
              <Input
                id="linkUrl"
                value={formLinkUrl}
                onChange={(e) => setFormLinkUrl(e.target.value)}
                placeholder="https://example.com/landing-page"
              />
            </div>

            {/* Position and Display Order */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="position">Position</Label>
                <select
                  id="position"
                  value={formPosition}
                  onChange={(e) => setFormPosition(e.target.value as BannerPosition)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2"
                >
                  {POSITION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="displayOrder">
                  <div className="flex items-center gap-1">
                    <ArrowUpDown className="h-3 w-3" />
                    Display Order
                  </div>
                </Label>
                <Input
                  id="displayOrder"
                  type="number"
                  min="0"
                  value={formDisplayOrder}
                  onChange={(e) => setFormDisplayOrder(e.target.value)}
                  placeholder="0"
                />
              </div>
            </div>

            {/* Schedule */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startsAt">Start Date (optional)</Label>
                <Input
                  id="startsAt"
                  type="datetime-local"
                  value={formStartsAt}
                  onChange={(e) => setFormStartsAt(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endsAt">End Date (optional)</Label>
                <Input
                  id="endsAt"
                  type="datetime-local"
                  value={formEndsAt}
                  onChange={(e) => setFormEndsAt(e.target.value)}
                />
              </div>
            </div>

            {/* Colors */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="backgroundColor">
                  <div className="flex items-center gap-1">
                    <Palette className="h-3 w-3" />
                    Background Color
                  </div>
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="backgroundColor"
                    type="color"
                    value={formBackgroundColor || '#ffffff'}
                    onChange={(e) => setFormBackgroundColor(e.target.value)}
                    className="w-12 h-9 p-1"
                  />
                  <Input
                    type="text"
                    value={formBackgroundColor}
                    onChange={(e) => setFormBackgroundColor(e.target.value)}
                    placeholder="#FFFFFF"
                    className="flex-1"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="textColor">
                  <div className="flex items-center gap-1">
                    <Palette className="h-3 w-3" />
                    Text Color
                  </div>
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="textColor"
                    type="color"
                    value={formTextColor || '#000000'}
                    onChange={(e) => setFormTextColor(e.target.value)}
                    className="w-12 h-9 p-1"
                  />
                  <Input
                    type="text"
                    value={formTextColor}
                    onChange={(e) => setFormTextColor(e.target.value)}
                    placeholder="#000000"
                    className="flex-1"
                  />
                </div>
              </div>
            </div>

            {/* Is Active */}
            <div className="flex items-center gap-2">
              <Switch
                id="isActive"
                checked={formIsActive}
                onCheckedChange={setFormIsActive}
              />
              <Label htmlFor="isActive">Active</Label>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!isFormValid() || createMutation.isPending}
            >
              {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Banner
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Banner</DialogTitle>
            <DialogDescription>Update the banner details</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Title */}
            <div className="space-y-2">
              <Label htmlFor="edit-title">
                Title <span className="text-red-500">*</span>
              </Label>
              <Input
                id="edit-title"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="Summer Sale 2025"
              />
            </div>

            {/* Subtitle */}
            <div className="space-y-2">
              <Label htmlFor="edit-subtitle">Subtitle</Label>
              <Input
                id="edit-subtitle"
                value={formSubtitle}
                onChange={(e) => setFormSubtitle(e.target.value)}
                placeholder="Get 50% off all plans"
              />
            </div>

            {/* Image URL */}
            <div className="space-y-2">
              <Label htmlFor="edit-imageUrl">
                Image URL <span className="text-red-500">*</span>
              </Label>
              <Input
                id="edit-imageUrl"
                value={formImageUrl}
                onChange={(e) => setFormImageUrl(e.target.value)}
                placeholder="https://example.com/banner.jpg"
              />
              {formImageUrl && (
                <div className="mt-2 h-32 w-full rounded-md overflow-hidden border bg-muted">
                  <img
                    src={formImageUrl}
                    alt="Banner preview"
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </div>
              )}
            </div>

            {/* Link URL */}
            <div className="space-y-2">
              <Label htmlFor="edit-linkUrl">
                <div className="flex items-center gap-1">
                  <Link className="h-3 w-3" />
                  Link URL
                </div>
              </Label>
              <Input
                id="edit-linkUrl"
                value={formLinkUrl}
                onChange={(e) => setFormLinkUrl(e.target.value)}
                placeholder="https://example.com/landing-page"
              />
            </div>

            {/* Position and Display Order */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-position">Position</Label>
                <select
                  id="edit-position"
                  value={formPosition}
                  onChange={(e) => setFormPosition(e.target.value as BannerPosition)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2"
                >
                  {POSITION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-displayOrder">
                  <div className="flex items-center gap-1">
                    <ArrowUpDown className="h-3 w-3" />
                    Display Order
                  </div>
                </Label>
                <Input
                  id="edit-displayOrder"
                  type="number"
                  min="0"
                  value={formDisplayOrder}
                  onChange={(e) => setFormDisplayOrder(e.target.value)}
                  placeholder="0"
                />
              </div>
            </div>

            {/* Schedule */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-startsAt">Start Date (optional)</Label>
                <Input
                  id="edit-startsAt"
                  type="datetime-local"
                  value={formStartsAt}
                  onChange={(e) => setFormStartsAt(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-endsAt">End Date (optional)</Label>
                <Input
                  id="edit-endsAt"
                  type="datetime-local"
                  value={formEndsAt}
                  onChange={(e) => setFormEndsAt(e.target.value)}
                />
              </div>
            </div>

            {/* Colors */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-backgroundColor">
                  <div className="flex items-center gap-1">
                    <Palette className="h-3 w-3" />
                    Background Color
                  </div>
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="edit-backgroundColor"
                    type="color"
                    value={formBackgroundColor || '#ffffff'}
                    onChange={(e) => setFormBackgroundColor(e.target.value)}
                    className="w-12 h-9 p-1"
                  />
                  <Input
                    type="text"
                    value={formBackgroundColor}
                    onChange={(e) => setFormBackgroundColor(e.target.value)}
                    placeholder="#FFFFFF"
                    className="flex-1"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-textColor">
                  <div className="flex items-center gap-1">
                    <Palette className="h-3 w-3" />
                    Text Color
                  </div>
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="edit-textColor"
                    type="color"
                    value={formTextColor || '#000000'}
                    onChange={(e) => setFormTextColor(e.target.value)}
                    className="w-12 h-9 p-1"
                  />
                  <Input
                    type="text"
                    value={formTextColor}
                    onChange={(e) => setFormTextColor(e.target.value)}
                    placeholder="#000000"
                    className="flex-1"
                  />
                </div>
              </div>
            </div>

            {/* Is Active */}
            <div className="flex items-center gap-2">
              <Switch
                id="edit-isActive"
                checked={formIsActive}
                onCheckedChange={setFormIsActive}
              />
              <Label htmlFor="edit-isActive">Active</Label>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleUpdate}
              disabled={!isFormValid() || updateMutation.isPending}
            >
              {updateMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Update Banner
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Statistics Dialog */}
      <Dialog open={isStatsDialogOpen} onOpenChange={setIsStatsDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Banner Statistics</DialogTitle>
            <DialogDescription>
              Performance metrics for "{viewingStatsBanner?.title}"
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {isStatsLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin" />
              </div>
            ) : bannerStats ? (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-4">
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="text-xs font-medium">Impressions</CardTitle>
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-xl font-bold">{bannerStats.impressionCount.toLocaleString()}</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="text-xs font-medium">Clicks</CardTitle>
                      <MousePointer className="h-4 w-4 text-blue-500" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-xl font-bold">{bannerStats.clickCount.toLocaleString()}</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="text-xs font-medium">CTR</CardTitle>
                      <BarChart3 className="h-4 w-4 text-purple-500" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-xl font-bold">{bannerStats.ctr}%</div>
                    </CardContent>
                  </Card>
                </div>

                {/* CTR Progress Bar */}
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Click-Through Rate</span>
                    <span className="font-medium">{bannerStats.ctr}%</span>
                  </div>
                  <div className="h-2 bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${Math.min(bannerStats.ctr * 10, 100)}%` }}
                    />
                  </div>
                </div>

                {/* Banner Preview */}
                {viewingStatsBanner?.imageUrl && (
                  <div className="space-y-2">
                    <Label>Banner Preview</Label>
                    <div className="rounded-md overflow-hidden border bg-muted">
                      <img
                        src={viewingStatsBanner.imageUrl}
                        alt={viewingStatsBanner.title}
                        className="w-full h-32 object-cover"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center text-muted-foreground py-8">
                No statistics available
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Alert Dialog */}
      <AlertDialog open={!!deletingBanner} onOpenChange={() => setDeletingBanner(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Banner</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the banner "{deletingBanner?.title}"?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
