import { Copy, Download } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useEffect, useState } from 'react';
import type { UserSubscription } from '@/api/client.service';

/**
 * QRCodeModal props interface
 */
interface QRCodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  subscription: UserSubscription | null;
  qrData: string;
}

/**
 * QRCodeModal component
 * Displays QR code for subscription
 */
export function QRCodeModal({ isOpen, onClose, subscription, qrData }: QRCodeModalProps): React.ReactElement {
  const [copied, setCopied] = useState(false);

  // Reset copied state when modal opens
  useEffect(() => {
    if (isOpen) {
      setCopied(false);
    }
  }, [isOpen]);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(qrData);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Generate QR code URL using a free API
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrData)}`;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>QR код подписки</DialogTitle>
          <DialogDescription>
            Отсканируйте QR код для быстрого подключения
          </DialogDescription>
        </DialogHeader>

        {subscription && (
          <div className="space-y-4">
            {/* Subscription Info */}
            <div className="rounded-lg bg-muted p-3">
              <p className="font-medium">{subscription.planName}</p>
              <p className="text-sm text-muted-foreground">
                ID: {subscription.id}
              </p>
            </div>

            {/* QR Code */}
            <div className="flex justify-center">
              <div className="rounded-lg border bg-white p-4">
                <img
                  src={qrCodeUrl}
                  alt="QR Code"
                  className="h-48 w-48"
                />
              </div>
            </div>

            {/* Connection URL */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Ссылка подключения:</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={qrData}
                  readOnly
                  className="flex-1 rounded-md border bg-muted px-3 py-2 text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopy}
                >
                  {copied ? (
                    <span className="text-green-500 text-xs">OK</span>
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => window.open(qrCodeUrl, '_blank')}
              >
                <Download className="mr-2 h-4 w-4" />
                Скачать
              </Button>
              <Button onClick={onClose} className="flex-1">
                Закрыть
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default QRCodeModal;
