import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { trialAdminApi, type TrialSettings, type TrialStats } from '@/api/admin/trial';
import { Badge } from '@/components/ui/badge';

/**
 * Trial settings admin page component
 */
export function TrialSettingsPage() {
  const [settings, setSettings] = useState<TrialSettings>({
    isEnabled: true,
    durationDays: 3,
    trafficLimitGb: 10,
    deviceTypes: ['ANDROID', 'IPHONE', 'WINDOWS', 'MAC'],
    maxUsesPerUser: 1,
    requirePhone: false,
  });
  const [stats, setStats] = useState<TrialStats>({
    totalTrials: 0,
    activeTrials: 0,
    convertedToPaid: 0,
    conversionRate: 0,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
    loadStats();
  }, []);

  const loadSettings = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await trialAdminApi.getSettings();
      setSettings(data);
    } catch (err) {
      setError('Failed to load settings');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const data = await trialAdminApi.getStats();
      setStats(data);
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await trialAdminApi.updateSettings(settings);
      setSuccess('Settings saved successfully');
    } catch {
      setError('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleResetUser = async (userId: string) => {
    setError(null);
    try {
      await trialAdminApi.resetUser(userId);
      setSuccess('Trial reset for user');
      loadStats();
    } catch {
      setError('Failed to reset trial');
    }
  };

  const handleGrantTrial = async () => {
    const userId = prompt('Enter user ID:');
    if (!userId) return;

    const daysStr = prompt('Duration (days):', '7');
    const durationDays = daysStr ? parseInt(daysStr) : undefined;

    setError(null);
    try {
      await trialAdminApi.grant({ userId, durationDays });
      setSuccess('Trial granted successfully');
      loadStats();
    } catch {
      setError('Failed to grant trial');
    }
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

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
        <h1 className="text-3xl font-bold">Trial Settings</h1>
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Settings
        </Button>
      </div>

      {/* Statistics */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold">{stats.totalTrials}</div>
            <p className="text-muted-foreground">Total Trials</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold">{stats.activeTrials}</div>
            <p className="text-muted-foreground">Active Now</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold">{stats.convertedToPaid}</div>
            <p className="text-muted-foreground">Converted to Paid</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold">{stats.conversionRate}%</div>
            <p className="text-muted-foreground">Conversion Rate</p>
          </CardContent>
        </Card>
      </div>

      {/* Main Settings */}
      <Card>
        <CardHeader>
          <CardTitle>General Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-base">Enable Trial</Label>
              <p className="text-sm text-muted-foreground">
                Allow users to activate trial period
              </p>
            </div>
            <Switch
              checked={settings.isEnabled}
              onCheckedChange={(checked) => setSettings({ ...settings, isEnabled: checked })}
            />
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label>Trial Duration (days)</Label>
              <Input
                type="number"
                value={settings.durationDays}
                onChange={(e) =>
                  setSettings({ ...settings, durationDays: parseInt(e.target.value) || 1 })
                }
                min={1}
                max={30}
              />
            </div>
            <div className="space-y-2">
              <Label>Traffic Limit (GB)</Label>
              <Input
                type="number"
                value={settings.trafficLimitGb}
                onChange={(e) =>
                  setSettings({ ...settings, trafficLimitGb: parseInt(e.target.value) || 0 })
                }
                min={0}
              />
            </div>
            <div className="space-y-2">
              <Label>Max Trials Per User</Label>
              <Input
                type="number"
                value={settings.maxUsesPerUser}
                onChange={(e) =>
                  setSettings({ ...settings, maxUsesPerUser: parseInt(e.target.value) || 1 })
                }
                min={1}
                max={10}
              />
            </div>
            <div className="space-y-2">
              <Label>Require Phone</Label>
              <div className="flex items-center gap-2 mt-2">
                <Switch
                  checked={settings.requirePhone}
                  onCheckedChange={(checked) =>
                    setSettings({ ...settings, requirePhone: checked })
                  }
                />
                <span className="text-sm text-muted-foreground">
                  {settings.requirePhone ? 'Yes' : 'No'}
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Available Devices</Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {['ANDROID', 'IPHONE', 'WINDOWS', 'MAC'].map((device) => (
                <Badge
                  key={device}
                  variant={settings.deviceTypes.includes(device) ? 'default' : 'outline'}
                  className="cursor-pointer"
                  onClick={() => {
                    const newTypes = settings.deviceTypes.includes(device)
                      ? settings.deviceTypes.filter((d) => d !== device)
                      : [...settings.deviceTypes, device];
                    setSettings({ ...settings, deviceTypes: newTypes });
                  }}
                >
                  {device === 'ANDROID' && '📱 Android'}
                  {device === 'IPHONE' && '📱 iPhone'}
                  {device === 'WINDOWS' && '💻 Windows'}
                  {device === 'MAC' && '💻 Mac'}
                </Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Button
              variant="outline"
              onClick={() => {
                const userId = prompt('Enter user ID:');
                if (userId) handleResetUser(userId);
              }}
            >
              Reset Trial for User
            </Button>
            <Button
              variant="outline"
              onClick={handleGrantTrial}
            >
              Grant Trial Manually
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default TrialSettingsPage;
