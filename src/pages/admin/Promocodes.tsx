import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { promocodeAdminApi, type Promocode, type PromocodeRewardType, type PromocodeAvailability } from '@/api/admin/promocode';

/**
 * Promocodes admin page component
 */
export function PromocodesPage() {
  const { t } = useTranslation('admin');
  const [promocodes, setPromocodes] = useState<Promocode[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formData, setFormData] = useState({
    code: '',
    description: '',
    reward_type: 'PURCHASE_DISCOUNT' as PromocodeRewardType,
    reward_value: 0,
    discount_percent: 0,
    max_uses: 100,
    availability: 'ALL' as PromocodeAvailability,
    starts_at: '',
    ends_at: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    loadPromocodes();
  }, []);

  const loadPromocodes = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await promocodeAdminApi.getAll();
      setPromocodes(data);
    } catch (err) {
      setError(t('promocodes:noPromocodes'));
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    setError(null);
    setSuccess(null);
    try {
      await promocodeAdminApi.create(formData);
      setSuccess(t('promocodes:createSuccess'));
      setDialogOpen(false);
      loadPromocodes();
    } catch (err) {
      setError(t('promocodes:createError'));
      console.error(err);
    }
  };

  const handleToggle = async (id: string, _currentStatus: boolean) => {
    setError(null);
    try {
      await promocodeAdminApi.toggle(id);
      loadPromocodes();
    } catch (err) {
      setError(t('promocodes:toggleError'));
      console.error(err);
    }
  };

  const getRewardBadge = (type: PromocodeRewardType, value: number) => {
    const labels: Record<PromocodeRewardType, { label: string; color: string }> = {
      DURATION: { label: t('promocodes:rewardLabels.duration', { value }), color: 'bg-blue-100 text-blue-800' },
      TRAFFIC: { label: t('promocodes:rewardLabels.traffic', { value }), color: 'bg-green-100 text-green-800' },
      DEVICES: { label: t('promocodes:rewardLabels.devices', { value }), color: 'bg-purple-100 text-purple-800' },
      SUBSCRIPTION: { label: t('promocodes:rewardLabels.subscription'), color: 'bg-yellow-100 text-yellow-800' },
      PERSONAL_DISCOUNT: { label: t('promocodes:rewardLabels.personalDiscount', { value }), color: 'bg-cyan-100 text-cyan-800' },
      PURCHASE_DISCOUNT: { label: t('promocodes:rewardLabels.purchaseDiscount', { value }), color: 'bg-orange-100 text-orange-800' },
    };
    const config = labels[type];
    return <Badge className={config.color}>{config.label}</Badge>;
  };

  return (
    <div className="p-6 space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-2 rounded">
          {success}
        </div>
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">{t('promocodes:title')}</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              {t('promocodes:create')}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t('promocodes:createTitle')}</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('promocodes:code')}</label>
                <Input
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                  placeholder="SUMMER2024"
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('promocodes:rewardType')}</label>
                <Select
                  value={formData.reward_type}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    setFormData({ ...formData, reward_type: e.target.value as PromocodeRewardType })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="DURATION">{t('promocodes:rewardTypes.DURATION')}</SelectItem>
                    <SelectItem value="TRAFFIC">{t('promocodes:rewardTypes.TRAFFIC')}</SelectItem>
                    <SelectItem value="DEVICES">{t('promocodes:rewardTypes.DEVICES')}</SelectItem>
                    <SelectItem value="SUBSCRIPTION">{t('promocodes:rewardTypes.SUBSCRIPTION')}</SelectItem>
                    <SelectItem value="PERSONAL_DISCOUNT">{t('promocodes:rewardTypes.PERSONAL_DISCOUNT')}</SelectItem>
                    <SelectItem value="PURCHASE_DISCOUNT">{t('promocodes:rewardTypes.PURCHASE_DISCOUNT')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('promocodes:rewardValue')}</label>
                <Input
                  type="number"
                  value={formData.reward_value}
                  onChange={(e) => setFormData({ ...formData, reward_value: parseInt(e.target.value) || 0 })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('promocodes:discountPercent')}</label>
                <Input
                  type="number"
                  value={formData.discount_percent}
                  onChange={(e) => setFormData({ ...formData, discount_percent: parseInt(e.target.value) || 0 })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('promocodes:maxUses')}</label>
                <Input
                  type="number"
                  value={formData.max_uses}
                  onChange={(e) => setFormData({ ...formData, max_uses: parseInt(e.target.value) || 0 })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('promocodes:availability')}</label>
                <Select
                  value={formData.availability}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    setFormData({ ...formData, availability: e.target.value as PromocodeAvailability })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">{t('promocodes:availabilityTypes.ALL')}</SelectItem>
                    <SelectItem value="NEW">{t('promocodes:availabilityTypes.NEW')}</SelectItem>
                    <SelectItem value="EXISTING">{t('promocodes:availabilityTypes.EXISTING')}</SelectItem>
                    <SelectItem value="INVITED">{t('promocodes:availabilityTypes.INVITED')}</SelectItem>
                    <SelectItem value="ALLOWED">{t('promocodes:availabilityTypes.ALLOWED')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('promocodes:startDate')}</label>
                <Input
                  type="datetime-local"
                  value={formData.starts_at}
                  onChange={(e) => setFormData({ ...formData, starts_at: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('promocodes:endDate')}</label>
                <Input
                  type="datetime-local"
                  value={formData.ends_at}
                  onChange={(e) => setFormData({ ...formData, ends_at: e.target.value })}
                />
              </div>
              <div className="col-span-2 space-y-2">
                <label className="text-sm font-medium">{t('promocodes:description')}</label>
                <Input
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder={t('promocodes:descriptionPlaceholder')}
                />
              </div>
            </div>
            <Button onClick={handleCreate} className="w-full mt-4">
              {t('promocodes:create')}
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('promocodes:code')}</TableHead>
              <TableHead>{t('promocodes:rewardType')}</TableHead>
              <TableHead>{t('promocodes:usage')}</TableHead>
              <TableHead>{t('promocodes:status')}</TableHead>
              <TableHead>{t('promocodes:created')}</TableHead>
              <TableHead>{t('promocodes:actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center">
                  <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                </TableCell>
              </TableRow>
            ) : promocodes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center">
                  {t('promocodes:noPromocodes')}
                </TableCell>
              </TableRow>
            ) : (
              promocodes.map((promocode) => (
                <TableRow key={promocode.id}>
                  <TableCell>
                    <code className="bg-muted px-2 py-1 rounded font-mono">{promocode.code}</code>
                  </TableCell>
                  <TableCell>{getRewardBadge(promocode.reward_type, promocode.reward_value)}</TableCell>
                  <TableCell>
                    {promocode.usage_count} / {promocode.max_uses}
                  </TableCell>
                  <TableCell>
                    <Badge variant={promocode.is_active ? 'default' : 'secondary'}>
                      {promocode.is_active ? t('promocodes:active') : t('promocodes:inactive')}
                    </Badge>
                  </TableCell>
                  <TableCell>{new Date(promocode.created_at).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleToggle(promocode.id, promocode.is_active)}
                    >
                      {promocode.is_active ? t('promocodes:deactivate') : t('promocodes:activate')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

export default PromocodesPage;
