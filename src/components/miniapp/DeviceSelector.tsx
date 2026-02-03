/**
 * DeviceSelector Component
 * Component for selecting device types when purchasing subscriptions
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Device type enum
 */
type DeviceType = 'ANDROID' | 'IPHONE' | 'WINDOWS' | 'MAC';

/**
 * Device option interface
 */
interface DeviceOption {
  type: DeviceType;
  label: string;
  icon: string;
  description: string;
}

/**
 * Available device options
 */
const DEVICE_OPTIONS: DeviceOption[] = [
  {
    type: 'ANDROID',
    label: 'Android',
    icon: '📱',
    description: 'Смартфоны и планшеты Android',
  },
  {
    type: 'IPHONE',
    label: 'iPhone',
    icon: '📱',
    description: 'iPhone и iPad',
  },
  {
    type: 'WINDOWS',
    label: 'Windows',
    icon: '💻',
    description: 'Компьютеры Windows',
  },
  {
    type: 'MAC',
    label: 'Mac',
    icon: '💻',
    description: 'Mac и MacBook',
  },
];

/**
 * Device selector props interface
 */
interface DeviceSelectorProps {
  /** Number of devices to select (triggers multiple mode if > 1) */
  quantity?: number;
  /** Currently selected devices */
  selected?: DeviceType[];
  /** Callback when selection changes */
  onChange: (devices: DeviceType[]) => void;
  /** Maximum number of devices that can be selected */
  maxDevices?: number;
}

/**
 * DeviceSelector Component
 * Allows users to select device types for their subscription
 */
export function DeviceSelector({
  quantity = 1,
  selected = [],
  onChange,
  maxDevices = 5,
}: DeviceSelectorProps): React.ReactElement {
  const [selectionMode, setSelectionMode] = useState<'single' | 'multiple'>('single');

  /**
   * Handle device toggle
   */
  const handleDeviceToggle = (device: DeviceType): void => {
    if (selectionMode === 'single') {
      onChange([device]);
    } else {
      const newSelection = selected.includes(device)
        ? selected.filter((d) => d !== device)
        : [...selected, device].slice(0, maxDevices);
      onChange(newSelection);
    }
  };

  /**
   * Check if device is selected
   */
  const isSelected = (device: DeviceType): boolean => selected.includes(device);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Выберите устройства</CardTitle>
          {quantity > 1 && (
            <div className="flex gap-2">
              <Button
                variant={selectionMode === 'single' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setSelectionMode('single');
                  onChange(selected.slice(0, 1));
                }}
              >
                Один
              </Button>
              <Button
                variant={selectionMode === 'multiple' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelectionMode('multiple')}
              >
                Несколько
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {selectionMode === 'multiple' && selected.length > 0 && (
          <div className="mb-4 p-3 bg-muted rounded-lg">
            <p className="text-sm font-medium mb-2">Выбрано: {selected.length} из {maxDevices}</p>
            <div className="flex flex-wrap gap-2">
              {selected.map((device) => (
                <span
                  key={device}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-primary text-primary-foreground rounded text-sm"
                >
                  {DEVICE_OPTIONS.find((d) => d.type === device)?.icon}{' '}
                  {DEVICE_OPTIONS.find((d) => d.type === device)?.label}
                  <button
                    type="button"
                    onClick={() => handleDeviceToggle(device)}
                    className="ml-1 hover:opacity-70"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          {DEVICE_OPTIONS.map((device) => (
            <button
              key={device.type}
              type="button"
              onClick={() => handleDeviceToggle(device.type)}
              className={cn(
                'p-4 rounded-lg border-2 text-left transition-all',
                isSelected(device.type)
                  ? 'border-primary bg-primary/5'
                  : 'border-muted hover:border-primary/50'
              )}
            >
              <div className="flex items-start gap-3">
                <span className="text-2xl">{device.icon}</span>
                <div>
                  <p className="font-medium">{device.label}</p>
                  <p className="text-xs text-muted-foreground">{device.description}</p>
                </div>
              </div>
              {isSelected(device.type) && (
                <div className="mt-2 flex items-center gap-1 text-primary text-sm">
                  <span className="font-medium">✓ Выбрано</span>
                </div>
              )}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default DeviceSelector;
