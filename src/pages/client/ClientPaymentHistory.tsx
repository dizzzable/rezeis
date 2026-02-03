import { useEffect, useState } from 'react';
import { History, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { useClientPayments, useClientStore } from '@/stores/client.store';

/**
 * Format date to readable string
 */
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Get status badge variant
 */
function getStatusBadge(status: string): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  switch (status) {
    case 'completed':
    case 'paid':
      return { label: 'Оплачено', variant: 'default' };
    case 'pending':
      return { label: 'Ожидает', variant: 'outline' };
    case 'failed':
      return { label: 'Ошибка', variant: 'destructive' };
    case 'cancelled':
      return { label: 'Отменено', variant: 'secondary' };
    default:
      return { label: status, variant: 'secondary' };
  }
}

/**
 * ClientPaymentHistory page component
 * Displays payment history with pagination
 */
export default function ClientPaymentHistory(): React.ReactElement {
  const { payments, isLoading } = useClientPayments();
  const fetchPaymentHistory = useClientStore((state) => state.fetchPaymentHistory);
  const [page, setPage] = useState(1);
  const limit = 10;

  // Fetch payments on mount
  useEffect(() => {
    fetchPaymentHistory(page, limit);
  }, [fetchPaymentHistory, page]);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">История платежей</h1>
        <p className="text-muted-foreground mt-1">
          История ваших платежей и транзакций
        </p>
      </div>

      {/* Payments Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Список платежей
          </CardTitle>
          <CardDescription>
            Все ваши платежи за подписки
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : payments.length === 0 ? (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Нет платежей</AlertTitle>
              <AlertDescription>
                У вас пока нет истории платежей.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Дата</TableHead>
                      <TableHead>Тариф</TableHead>
                      <TableHead>Платежная система</TableHead>
                      <TableHead>Сумма</TableHead>
                      <TableHead>Статус</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.map((payment) => {
                      const statusBadge = getStatusBadge(payment.status);
                      return (
                        <TableRow key={payment.id}>
                          <TableCell>{formatDate(payment.createdAt)}</TableCell>
                          <TableCell>{payment.planName || 'N/A'}</TableCell>
                          <TableCell>{payment.gatewayName || 'N/A'}</TableCell>
                          <TableCell>
                            {payment.amount} {payment.currency}
                          </TableCell>
                          <TableCell>
                            <Badge variant={statusBadge.variant}>
                              {statusBadge.label}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between mt-4">
                <p className="text-sm text-muted-foreground">
                  Показано {payments.length} записей
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    Назад
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={payments.length < limit}
                  >
                    Вперед
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
