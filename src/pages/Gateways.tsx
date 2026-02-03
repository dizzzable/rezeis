import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CreditCard,
  Plus,
  Edit,
  Trash2,
  Loader2,
  CheckCircle,
  Star,
  Search,
  DollarSign,
  Percent,
  Settings,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { gatewaysService } from '@/api/gateways.service';
import type { Gateway, GatewayType, GatewayConfig } from '@/types/entity.types';

const GATEWAY_TYPE_OPTIONS: { value: GatewayType; label: string }[] = [
  { value: 'stripe', label: 'Stripe' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'cryptomus', label: 'Cryptomus' },
  { value: 'yookassa', label: 'YooKassa' },
  { value: 'custom', label: 'Custom' },
];

const CURRENCY_OPTIONS = ['USD', 'EUR', 'RUB', 'BTC', 'ETH', 'USDT'];

/**
 * Get gateway type color
 */
function getGatewayTypeColor(type: GatewayType): string {
  const colors: Record<GatewayType, string> = {
    stripe: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
    paypal: 'bg-blue-600/10 text-blue-600 border-blue-600/20',
    cryptomus: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
    yookassa: 'bg-red-500/10 text-red-500 border-red-500/20',
    custom: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  };
  return colors[type] || colors.custom;
}

/**
 * Get gateway type icon
 */
function getGatewayTypeIcon(type: GatewayType): string {
  const icons: Record<GatewayType, string> = {
    stripe: '💳',
    paypal: '🅿️',
    cryptomus: '🔐',
    yookassa: '💰',
    custom: '⚙️',
  };
  return icons[type] || '💳';
}

/**
 * Get config fields for gateway type
 */
function getConfigFields(type: GatewayType): { key: keyof GatewayConfig; label: string; type: string }[] {
  const fields: Record<GatewayType, { key: keyof GatewayConfig; label: string; type: string }[]> = {
    stripe: [
      { key: 'publishableKey', label: 'Publishable Key', type: 'text' },
      { key: 'secretKey', label: 'Secret Key', type: 'password' },
      { key: 'webhookSecret', label: 'Webhook Secret', type: 'password' },
    ],
    paypal: [
      { key: 'clientId', label: 'Client ID', type: 'text' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password' },
    ],
    cryptomus: [
      { key: 'apiKey', label: 'API Key', type: 'password' },
      { key: 'merchantId', label: 'Merchant ID', type: 'text' },
    ],
    yookassa: [
      { key: 'shopId', label: 'Shop ID', type: 'text' },
      { key: 'secretKeyYookassa', label: 'Secret Key', type: 'password' },
    ],
    custom: [
      { key: 'endpoint', label: 'Endpoint URL', type: 'text' },
      { key: 'apiToken', label: 'API Token', type: 'password' },
    ],
  };
  return fields[type] || fields.custom;
}

export default function GatewaysPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingGateway, setEditingGateway] = useState<Gateway | null>(null);
  const [deletingGateway, setDeletingGateway] = useState<Gateway | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Form state
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState<GatewayType>('stripe');
  const [formDescription, setFormDescription] = useState('');
  const [formIsActive, setFormIsActive] = useState(true);
  const [formIsDefault, setFormIsDefault] = useState(false);
  const [formDisplayOrder, setFormDisplayOrder] = useState('0');
  const [formMinAmount, setFormMinAmount] = useState('');
  const [formMaxAmount, setFormMaxAmount] = useState('');
  const [formFeePercent, setFormFeePercent] = useState('');
  const [formFeeFixed, setFormFeeFixed] = useState('');
  const [formSupportedCurrencies, setFormSupportedCurrencies] = useState<string[]>(['USD']);
  const [formConfig, setFormConfig] = useState<GatewayConfig>({});

  const { data: gateways, isLoading } = useQuery({
    queryKey: ['gateways'],
    queryFn: () => gatewaysService.getAll(),
  });

  const filteredGateways = useMemo(() => {
    if (!gateways) return [];
    if (!searchQuery) return gateways;
    return gateways.filter(
      (gateway) =>
        gateway.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        gateway.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        gateway.type.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [gateways, searchQuery]);

  const createMutation = useMutation({
    mutationFn: gatewaysService.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gateways'] });
      setIsCreateDialogOpen(false);
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof gatewaysService.update>[1] }) =>
      gatewaysService.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gateways'] });
      setIsEditDialogOpen(false);
      setEditingGateway(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: gatewaysService.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gateways'] });
      setDeletingGateway(null);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: gatewaysService.toggleActive,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gateways'] });
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: gatewaysService.setDefault,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gateways'] });
    },
  });

  const resetForm = () => {
    setFormName('');
    setFormType('stripe');
    setFormDescription('');
    setFormIsActive(true);
    setFormIsDefault(false);
    setFormDisplayOrder('0');
    setFormMinAmount('');
    setFormMaxAmount('');
    setFormFeePercent('');
    setFormFeeFixed('');
    setFormSupportedCurrencies(['USD']);
    setFormConfig({});
  };

  const populateEditForm = (gateway: Gateway) => {
    setFormName(gateway.name);
    setFormType(gateway.type);
    setFormDescription(gateway.description || '');
    setFormIsActive(gateway.isActive);
    setFormIsDefault(gateway.isDefault);
    setFormDisplayOrder(gateway.displayOrder.toString());
    setFormMinAmount(gateway.minAmount?.toString() || '');
    setFormMaxAmount(gateway.maxAmount?.toString() || '');
    setFormFeePercent(gateway.feePercent?.toString() || '');
    setFormFeeFixed(gateway.feeFixed?.toString() || '');
    setFormSupportedCurrencies(gateway.supportedCurrencies || ['USD']);
    setFormConfig(gateway.config || {});
  };

  const handleCreate = () => {
    createMutation.mutate({
      name: formName,
      type: formType,
      description: formDescription || undefined,
      isActive: formIsActive,
      isDefault: formIsDefault,
      displayOrder: parseInt(formDisplayOrder) || 0,
      minAmount: formMinAmount ? parseFloat(formMinAmount) : undefined,
      maxAmount: formMaxAmount ? parseFloat(formMaxAmount) : undefined,
      feePercent: formFeePercent ? parseFloat(formFeePercent) : undefined,
      feeFixed: formFeeFixed ? parseFloat(formFeeFixed) : undefined,
      supportedCurrencies: formSupportedCurrencies,
      config: formConfig,
    });
  };

  const handleUpdate = () => {
    if (!editingGateway) return;
    updateMutation.mutate({
      id: editingGateway.id,
      data: {
        name: formName,
        type: formType,
        description: formDescription || undefined,
        isActive: formIsActive,
        isDefault: formIsDefault,
        displayOrder: parseInt(formDisplayOrder) || 0,
        minAmount: formMinAmount ? parseFloat(formMinAmount) : undefined,
        maxAmount: formMaxAmount ? parseFloat(formMaxAmount) : undefined,
        feePercent: formFeePercent ? parseFloat(formFeePercent) : undefined,
        feeFixed: formFeeFixed ? parseFloat(formFeeFixed) : undefined,
        supportedCurrencies: formSupportedCurrencies,
        config: formConfig,
      },
    });
  };

  const handleEditClick = (gateway: Gateway) => {
    setEditingGateway(gateway);
    populateEditForm(gateway);
    setIsEditDialogOpen(true);
  };

  const handleDeleteClick = (gateway: Gateway) => {
    setDeletingGateway(gateway);
  };

  const confirmDelete = () => {
    if (deletingGateway) {
      deleteMutation.mutate(deletingGateway.id);
    }
  };

  const isFormValid = () => {
    return formName.trim() && formType;
  };

  const toggleCurrency = (currency: string) => {
    setFormSupportedCurrencies((prev) =>
      prev.includes(currency)
        ? prev.filter((c) => c !== currency)
        : [...prev, currency]
    );
  };

  const updateConfigField = (key: keyof GatewayConfig, value: string) => {
    setFormConfig((prev) => ({ ...prev, [key]: value }));
  };

  // Stats
  const totalGateways = gateways?.length || 0;
  const activeGateways = gateways?.filter((g) => g.isActive).length || 0;
  const defaultGateway = gateways?.find((g) => g.isDefault);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Payment Gateways</h1>
          <p className="text-muted-foreground mt-1">
            Manage payment gateways and their configurations
          </p>
        </div>
        <Button onClick={() => setIsCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Gateway
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Gateways</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalGateways}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
            <CheckCircle className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeGateways}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Default Gateway</CardTitle>
            <Star className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold truncate">
              {defaultGateway ? defaultGateway.name : 'None'}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search gateways..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Gateways Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {isLoading ? (
          <div className="col-span-full flex justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        ) : filteredGateways.length === 0 ? (
          <div className="col-span-full text-center py-8 text-muted-foreground">
            {searchQuery ? 'No gateways found matching your search.' : 'No gateways yet. Add your first gateway to get started.'}
          </div>
        ) : (
          filteredGateways.map((gateway) => (
            <Card key={gateway.id} className={gateway.isDefault ? 'border-yellow-500/50' : ''}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{getGatewayTypeIcon(gateway.type)}</span>
                    <div>
                      <CardTitle className="flex items-center gap-2 text-lg">
                        {gateway.name}
                        {gateway.isDefault && (
                          <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                        )}
                      </CardTitle>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline" className={getGatewayTypeColor(gateway.type)}>
                          {gateway.type}
                        </Badge>
                        {gateway.isActive ? (
                          <Badge variant="default" className="bg-green-500">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Inactive</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                {gateway.description && (
                  <CardDescription className="mt-2">{gateway.description}</CardDescription>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Supported Currencies */}
                <div>
                  <p className="text-sm text-muted-foreground mb-2">Supported Currencies</p>
                  <div className="flex flex-wrap gap-1">
                    {gateway.supportedCurrencies?.map((currency) => (
                      <Badge key={currency} variant="outline" className="text-xs">
                        {currency}
                      </Badge>
                    )) || <span className="text-sm text-muted-foreground">None</span>}
                  </div>
                </div>

                <Separator />

                {/* Fee Info */}
                <div className="flex items-center gap-4 text-sm">
                  {(gateway.feePercent || gateway.feeFixed) ? (
                    <>
                      {gateway.feePercent && (
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <Percent className="h-3 w-3" />
                          <span>{gateway.feePercent}%</span>
                        </div>
                      )}
                      {gateway.feeFixed && (
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <DollarSign className="h-3 w-3" />
                          <span>{gateway.feeFixed}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">No fees</span>
                  )}
                  {(gateway.minAmount || gateway.maxAmount) && (
                    <span className="text-muted-foreground">
                      {gateway.minAmount ? `$${gateway.minAmount}` : '$0'} - {gateway.maxAmount ? `$${gateway.maxAmount}` : '∞'}
                    </span>
                  )}
                </div>

                <Separator />

                {/* Actions */}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => handleEditClick(gateway)}
                  >
                    <Edit className="mr-2 h-4 w-4" />
                    Edit
                  </Button>
                  {!gateway.isDefault && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => setDefaultMutation.mutate(gateway.id)}
                      disabled={setDefaultMutation.isPending}
                    >
                      <Star className="mr-2 h-4 w-4" />
                      Set Default
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => toggleMutation.mutate(gateway.id)}
                    disabled={toggleMutation.isPending}
                  >
                    {gateway.isActive ? (
                      <>
                        <ToggleRight className="mr-2 h-4 w-4" />
                        Deactivate
                      </>
                    ) : (
                      <>
                        <ToggleLeft className="mr-2 h-4 w-4" />
                        Activate
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 text-destructive hover:bg-destructive/10"
                    onClick={() => handleDeleteClick(gateway)}
                    disabled={gateway.isDefault}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}

        {/* Add New Gateway Card */}
        <Card
          className="flex flex-col items-center justify-center border-dashed cursor-pointer hover:bg-accent/50 transition-colors"
          onClick={() => setIsCreateDialogOpen(true)}
        >
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Plus className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="mt-4 font-semibold">Add New Gateway</h3>
            <p className="mt-2 text-center text-sm text-muted-foreground">
              Configure a new payment gateway
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Create Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add New Payment Gateway</DialogTitle>
            <DialogDescription>
              Configure a new payment gateway for your customers
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="name">
                Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="My Stripe Gateway"
              />
            </div>

            {/* Type */}
            <div className="space-y-2">
              <Label htmlFor="type">Gateway Type</Label>
              <select
                id="type"
                value={formType}
                onChange={(e) => {
                  setFormType(e.target.value as GatewayType);
                  setFormConfig({});
                }}
                className="w-full rounded-md border border-input bg-background px-3 py-2"
              >
                {GATEWAY_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Primary payment gateway for credit cards"
              />
            </div>

            {/* Status Checkboxes */}
            <div className="flex gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="isActive"
                  checked={formIsActive}
                  onCheckedChange={setFormIsActive}
                />
                <Label htmlFor="isActive">Active</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="isDefault"
                  checked={formIsDefault}
                  onCheckedChange={setFormIsDefault}
                />
                <Label htmlFor="isDefault">Set as Default</Label>
              </div>
            </div>

            <Separator />

            {/* Configuration */}
            <div className="space-y-3">
              <Label className="flex items-center gap-2">
                <Settings className="h-4 w-4" />
                Configuration ({formType})
              </Label>
              <div className="grid gap-3">
                {getConfigFields(formType).map((field) => (
                  <div key={field.key} className="space-y-1">
                    <Label htmlFor={`config-${field.key}`} className="text-sm text-muted-foreground">
                      {field.label}
                    </Label>
                    <Input
                      id={`config-${field.key}`}
                      type={field.type}
                      value={(formConfig[field.key] as string) || ''}
                      onChange={(e) => updateConfigField(field.key, e.target.value)}
                      placeholder={`Enter ${field.label.toLowerCase()}`}
                    />
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            {/* Amount Settings */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="minAmount">Min Amount</Label>
                <Input
                  id="minAmount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={formMinAmount}
                  onChange={(e) => setFormMinAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxAmount">Max Amount</Label>
                <Input
                  id="maxAmount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={formMaxAmount}
                  onChange={(e) => setFormMaxAmount(e.target.value)}
                  placeholder="No limit"
                />
              </div>
            </div>

            {/* Fee Settings */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="feePercent">Fee Percentage (%)</Label>
                <Input
                  id="feePercent"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={formFeePercent}
                  onChange={(e) => setFormFeePercent(e.target.value)}
                  placeholder="0"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="feeFixed">Fixed Fee</Label>
                <Input
                  id="feeFixed"
                  type="number"
                  min="0"
                  step="0.01"
                  value={formFeeFixed}
                  onChange={(e) => setFormFeeFixed(e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>

            {/* Display Order */}
            <div className="space-y-2">
              <Label htmlFor="displayOrder">Display Order</Label>
              <Input
                id="displayOrder"
                type="number"
                min="0"
                value={formDisplayOrder}
                onChange={(e) => setFormDisplayOrder(e.target.value)}
                placeholder="0"
              />
            </div>

            {/* Supported Currencies */}
            <div className="space-y-2">
              <Label>Supported Currencies</Label>
              <div className="flex flex-wrap gap-2">
                {CURRENCY_OPTIONS.map((currency) => (
                  <Button
                    key={currency}
                    type="button"
                    variant={formSupportedCurrencies.includes(currency) ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => toggleCurrency(currency)}
                  >
                    {currency}
                  </Button>
                ))}
              </div>
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
              Add Gateway
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Payment Gateway</DialogTitle>
            <DialogDescription>Update the gateway configuration</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="edit-name">
                Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="edit-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="My Stripe Gateway"
              />
            </div>

            {/* Type */}
            <div className="space-y-2">
              <Label htmlFor="edit-type">Gateway Type</Label>
              <select
                id="edit-type"
                value={formType}
                onChange={(e) => {
                  setFormType(e.target.value as GatewayType);
                  setFormConfig({});
                }}
                className="w-full rounded-md border border-input bg-background px-3 py-2"
              >
                {GATEWAY_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="edit-description">Description</Label>
              <Input
                id="edit-description"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Primary payment gateway for credit cards"
              />
            </div>

            {/* Status Checkboxes */}
            <div className="flex gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="edit-isActive"
                  checked={formIsActive}
                  onCheckedChange={setFormIsActive}
                />
                <Label htmlFor="edit-isActive">Active</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="edit-isDefault"
                  checked={formIsDefault}
                  onCheckedChange={setFormIsDefault}
                  disabled={editingGateway?.isDefault}
                />
                <Label htmlFor="edit-isDefault">Set as Default</Label>
              </div>
            </div>

            <Separator />

            {/* Configuration */}
            <div className="space-y-3">
              <Label className="flex items-center gap-2">
                <Settings className="h-4 w-4" />
                Configuration ({formType})
              </Label>
              <div className="grid gap-3">
                {getConfigFields(formType).map((field) => (
                  <div key={field.key} className="space-y-1">
                    <Label htmlFor={`edit-config-${field.key}`} className="text-sm text-muted-foreground">
                      {field.label}
                    </Label>
                    <Input
                      id={`edit-config-${field.key}`}
                      type={field.type}
                      value={(formConfig[field.key] as string) || ''}
                      onChange={(e) => updateConfigField(field.key, e.target.value)}
                      placeholder={`Enter ${field.label.toLowerCase()}`}
                    />
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            {/* Amount Settings */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-minAmount">Min Amount</Label>
                <Input
                  id="edit-minAmount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={formMinAmount}
                  onChange={(e) => setFormMinAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-maxAmount">Max Amount</Label>
                <Input
                  id="edit-maxAmount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={formMaxAmount}
                  onChange={(e) => setFormMaxAmount(e.target.value)}
                  placeholder="No limit"
                />
              </div>
            </div>

            {/* Fee Settings */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-feePercent">Fee Percentage (%)</Label>
                <Input
                  id="edit-feePercent"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={formFeePercent}
                  onChange={(e) => setFormFeePercent(e.target.value)}
                  placeholder="0"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-feeFixed">Fixed Fee</Label>
                <Input
                  id="edit-feeFixed"
                  type="number"
                  min="0"
                  step="0.01"
                  value={formFeeFixed}
                  onChange={(e) => setFormFeeFixed(e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>

            {/* Display Order */}
            <div className="space-y-2">
              <Label htmlFor="edit-displayOrder">Display Order</Label>
              <Input
                id="edit-displayOrder"
                type="number"
                min="0"
                value={formDisplayOrder}
                onChange={(e) => setFormDisplayOrder(e.target.value)}
                placeholder="0"
              />
            </div>

            {/* Supported Currencies */}
            <div className="space-y-2">
              <Label>Supported Currencies</Label>
              <div className="flex flex-wrap gap-2">
                {CURRENCY_OPTIONS.map((currency) => (
                  <Button
                    key={currency}
                    type="button"
                    variant={formSupportedCurrencies.includes(currency) ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => toggleCurrency(currency)}
                  >
                    {currency}
                  </Button>
                ))}
              </div>
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
              Update Gateway
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Alert Dialog */}
      <AlertDialog open={!!deletingGateway} onOpenChange={() => setDeletingGateway(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Gateway</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the gateway "{deletingGateway?.name}"?
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
