import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Ticket,
  Plus,
  Edit,
  Trash2,
  Loader2,
  Percent,
  DollarSign,
  Calendar,
  Users,
  CheckCircle,
  XCircle,
  Search,
  Tag,
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
import { promocodesService } from '@/api/promocodes.service';
import type { Promocode, DiscountType } from '@/types/entity.types';

const DISCOUNT_TYPE_OPTIONS: { value: DiscountType; label: string }[] = [
  { value: 'percentage', label: 'Percentage (%)' },
  { value: 'fixed_amount', label: 'Fixed Amount ($)' },
];

export default function PromocodesPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingPromocode, setEditingPromocode] = useState<Promocode | null>(null);
  const [deletingPromocode, setDeletingPromocode] = useState<Promocode | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Form state
  const [formCode, setFormCode] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formDiscountType, setFormDiscountType] = useState<DiscountType>('percentage');
  const [formDiscountValue, setFormDiscountValue] = useState('');
  const [formMaxUses, setFormMaxUses] = useState('');
  const [formExpiresAt, setFormExpiresAt] = useState('');
  const [formIsActive, setFormIsActive] = useState(true);

  const { data: promocodesResponse, isLoading } = useQuery({
    queryKey: ['promocodes'],
    queryFn: () => promocodesService.getPromocodes({ page: 1, limit: 100 }),
  });

  const promocodes = promocodesResponse?.data || [];

  const filteredPromocodes = useMemo(() => {
    if (!searchQuery) return promocodes;
    return promocodes.filter(
      (promocode) =>
        promocode.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
        promocode.description?.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [promocodes, searchQuery]);

  const createMutation = useMutation({
    mutationFn: promocodesService.createPromocode,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['promocodes'] });
      setIsCreateDialogOpen(false);
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof promocodesService.updatePromocode>[1] }) =>
      promocodesService.updatePromocode(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['promocodes'] });
      setIsEditDialogOpen(false);
      setEditingPromocode(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: promocodesService.deletePromocode,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['promocodes'] });
      setDeletingPromocode(null);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: promocodesService.toggleActive,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['promocodes'] });
    },
  });

  const resetForm = () => {
    setFormCode('');
    setFormDescription('');
    setFormDiscountType('percentage');
    setFormDiscountValue('');
    setFormMaxUses('');
    setFormExpiresAt('');
    setFormIsActive(true);
  };

  const populateEditForm = (promocode: Promocode) => {
    setFormCode(promocode.code);
    setFormDescription(promocode.description || '');
    setFormDiscountType(promocode.discountType);
    setFormDiscountValue(promocode.discountValue.toString());
    setFormMaxUses(promocode.maxUses?.toString() || '');
    setFormExpiresAt(promocode.expiresAt ? new Date(promocode.expiresAt).toISOString().slice(0, 16) : '');
    setFormIsActive(promocode.isActive);
  };

  const handleCreate = () => {
    createMutation.mutate({
      code: formCode.toUpperCase(),
      description: formDescription || undefined,
      discountType: formDiscountType,
      discountValue: parseFloat(formDiscountValue),
      maxUses: formMaxUses ? parseInt(formMaxUses) : undefined,
      expiresAt: formExpiresAt || undefined,
      isActive: formIsActive,
    });
  };

  const handleUpdate = () => {
    if (!editingPromocode) return;
    updateMutation.mutate({
      id: editingPromocode.id,
      data: {
        code: formCode.toUpperCase(),
        description: formDescription || undefined,
        discountType: formDiscountType,
        discountValue: parseFloat(formDiscountValue),
        maxUses: formMaxUses ? parseInt(formMaxUses) : undefined,
        expiresAt: formExpiresAt || undefined,
        isActive: formIsActive,
      },
    });
  };

  const handleEditClick = (promocode: Promocode) => {
    setEditingPromocode(promocode);
    populateEditForm(promocode);
    setIsEditDialogOpen(true);
  };

  const handleDeleteClick = (promocode: Promocode) => {
    setDeletingPromocode(promocode);
  };

  const confirmDelete = () => {
    if (deletingPromocode) {
      deleteMutation.mutate(deletingPromocode.id);
    }
  };

  const isFormValid = () => {
    return formCode.trim() && formDiscountValue && parseFloat(formDiscountValue) > 0;
  };

  const formatDiscount = (promocode: Promocode) => {
    if (promocode.discountType === 'percentage') {
      return `${promocode.discountValue}%`;
    }
    return `$${promocode.discountValue.toFixed(2)}`;
  };

  const getDiscountIcon = (type: DiscountType) => {
    return type === 'percentage' ? (
      <Percent className="h-4 w-4" />
    ) : (
      <DollarSign className="h-4 w-4" />
    );
  };

  const isExpired = (promocode: Promocode) => {
    if (!promocode.expiresAt) return false;
    return new Date(promocode.expiresAt) < new Date();
  };

  const isMaxedOut = (promocode: Promocode) => {
    if (!promocode.maxUses) return false;
    return promocode.usedCount >= promocode.maxUses;
  };

  // Stats
  const totalPromocodes = promocodes.length;
  const activePromocodes = promocodes.filter((p) => p.isActive && !isExpired(p) && !isMaxedOut(p)).length;
  const expiredPromocodes = promocodes.filter((p) => isExpired(p)).length;
  const totalUsage = promocodes.reduce((sum, p) => sum + p.usedCount, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Promocodes</h1>
          <p className="text-muted-foreground mt-1">
            Manage discount codes and promotional offers
          </p>
        </div>
        <Button onClick={() => setIsCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Promocode
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Promocodes</CardTitle>
            <Ticket className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalPromocodes}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
            <CheckCircle className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activePromocodes}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Expired</CardTitle>
            <XCircle className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{expiredPromocodes}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Usage</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalUsage}</div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search promocodes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Promocodes Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Promocodes</CardTitle>
          <CardDescription>View and manage your promotional codes</CardDescription>
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
                    <TableHead>Code</TableHead>
                    <TableHead>Discount</TableHead>
                    <TableHead>Usage</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPromocodes.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                        {searchQuery ? 'No promocodes found matching your search.' : 'No promocodes yet. Create your first promocode to get started.'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredPromocodes.map((promocode) => (
                      <TableRow key={promocode.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Tag className="h-4 w-4 text-muted-foreground" />
                            <span className="font-mono font-medium">{promocode.code}</span>
                          </div>
                          {promocode.description && (
                            <p className="text-xs text-muted-foreground mt-1">
                              {promocode.description}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {getDiscountIcon(promocode.discountType)}
                            <span className="font-medium">{formatDiscount(promocode)}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Users className="h-3 w-3 text-muted-foreground" />
                            <span>
                              {promocode.usedCount}
                              {promocode.maxUses ? ` / ${promocode.maxUses}` : ''}
                            </span>
                          </div>
                          {promocode.maxUses && (
                            <div className="w-24 h-1.5 bg-secondary rounded-full mt-1 overflow-hidden">
                              <div
                                className="h-full bg-primary transition-all"
                                style={{
                                  width: `${Math.min((promocode.usedCount / promocode.maxUses) * 100, 100)}%`,
                                }}
                              />
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {promocode.expiresAt ? (
                            <div className="flex items-center gap-1">
                              <Calendar className="h-3 w-3 text-muted-foreground" />
                              <span className={isExpired(promocode) ? 'text-red-500' : ''}>
                                {new Date(promocode.expiresAt).toLocaleDateString()}
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">Never</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={promocode.isActive}
                              onCheckedChange={() => toggleMutation.mutate(promocode.id)}
                              disabled={toggleMutation.isPending}
                            />
                            {isExpired(promocode) ? (
                              <Badge variant="destructive">Expired</Badge>
                            ) : isMaxedOut(promocode) ? (
                              <Badge variant="secondary">Maxed</Badge>
                            ) : promocode.isActive ? (
                              <Badge variant="default">Active</Badge>
                            ) : (
                              <Badge variant="secondary">Inactive</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleEditClick(promocode)}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDeleteClick(promocode)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create New Promocode</DialogTitle>
            <DialogDescription>
              Create a new discount code for your customers
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Code */}
            <div className="space-y-2">
              <Label htmlFor="code">
                Code <span className="text-red-500">*</span>
              </Label>
              <Input
                id="code"
                value={formCode}
                onChange={(e) => setFormCode(e.target.value.toUpperCase())}
                placeholder="SUMMER2025"
                className="font-mono"
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Summer sale discount"
              />
            </div>

            {/* Discount Type */}
            <div className="space-y-2">
              <Label htmlFor="discountType">Discount Type</Label>
              <select
                id="discountType"
                value={formDiscountType}
                onChange={(e) => setFormDiscountType(e.target.value as DiscountType)}
                className="w-full rounded-md border border-input bg-background px-3 py-2"
              >
                {DISCOUNT_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Discount Value */}
            <div className="space-y-2">
              <Label htmlFor="discountValue">
                Discount Value <span className="text-red-500">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="discountValue"
                  type="number"
                  min="0"
                  step={formDiscountType === 'percentage' ? '1' : '0.01'}
                  value={formDiscountValue}
                  onChange={(e) => setFormDiscountValue(e.target.value)}
                  placeholder={formDiscountType === 'percentage' ? '20' : '10.00'}
                />
                <div className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
                  {formDiscountType === 'percentage' ? '%' : '$'}
                </div>
              </div>
            </div>

            {/* Max Uses */}
            <div className="space-y-2">
              <Label htmlFor="maxUses">Max Uses (optional)</Label>
              <Input
                id="maxUses"
                type="number"
                min="1"
                value={formMaxUses}
                onChange={(e) => setFormMaxUses(e.target.value)}
                placeholder="Unlimited"
              />
            </div>

            {/* Expires At */}
            <div className="space-y-2">
              <Label htmlFor="expiresAt">Expiration Date (optional)</Label>
              <Input
                id="expiresAt"
                type="datetime-local"
                value={formExpiresAt}
                onChange={(e) => setFormExpiresAt(e.target.value)}
              />
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
              Create Promocode
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Promocode</DialogTitle>
            <DialogDescription>Update the promocode details</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Code */}
            <div className="space-y-2">
              <Label htmlFor="edit-code">
                Code <span className="text-red-500">*</span>
              </Label>
              <Input
                id="edit-code"
                value={formCode}
                onChange={(e) => setFormCode(e.target.value.toUpperCase())}
                placeholder="SUMMER2025"
                className="font-mono"
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="edit-description">Description</Label>
              <Input
                id="edit-description"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Summer sale discount"
              />
            </div>

            {/* Discount Type */}
            <div className="space-y-2">
              <Label htmlFor="edit-discountType">Discount Type</Label>
              <select
                id="edit-discountType"
                value={formDiscountType}
                onChange={(e) => setFormDiscountType(e.target.value as DiscountType)}
                className="w-full rounded-md border border-input bg-background px-3 py-2"
              >
                {DISCOUNT_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Discount Value */}
            <div className="space-y-2">
              <Label htmlFor="edit-discountValue">
                Discount Value <span className="text-red-500">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="edit-discountValue"
                  type="number"
                  min="0"
                  step={formDiscountType === 'percentage' ? '1' : '0.01'}
                  value={formDiscountValue}
                  onChange={(e) => setFormDiscountValue(e.target.value)}
                  placeholder={formDiscountType === 'percentage' ? '20' : '10.00'}
                />
                <div className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
                  {formDiscountType === 'percentage' ? '%' : '$'}
                </div>
              </div>
            </div>

            {/* Max Uses */}
            <div className="space-y-2">
              <Label htmlFor="edit-maxUses">Max Uses (optional)</Label>
              <Input
                id="edit-maxUses"
                type="number"
                min="1"
                value={formMaxUses}
                onChange={(e) => setFormMaxUses(e.target.value)}
                placeholder="Unlimited"
              />
            </div>

            {/* Expires At */}
            <div className="space-y-2">
              <Label htmlFor="edit-expiresAt">Expiration Date (optional)</Label>
              <Input
                id="edit-expiresAt"
                type="datetime-local"
                value={formExpiresAt}
                onChange={(e) => setFormExpiresAt(e.target.value)}
              />
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
              Update Promocode
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Alert Dialog */}
      <AlertDialog open={!!deletingPromocode} onOpenChange={() => setDeletingPromocode(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Promocode</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the promocode "{deletingPromocode?.code}"?
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
