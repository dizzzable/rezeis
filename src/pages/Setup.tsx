import { useState } from 'react';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, AlertCircle, Shield } from 'lucide-react';
import { authService } from '@/api/auth.service';

/**
 * Setup form validation schema
 */
const setupSchema = z.object({
  username: z.string().min(3, 'Имя пользователя должно быть не менее 3 символов'),
  password: z.string().min(8, 'Пароль должен быть не менее 8 символов'),
  telegramId: z.string().regex(/^\d+$/, 'Telegram ID должен содержать только цифры'),
});

/**
 * Setup form data type
 */
type SetupFormData = z.infer<typeof setupSchema>;

/**
 * Setup page component for initial super admin creation
 */
export default function Setup() {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SetupFormData>({
    resolver: zodResolver(setupSchema),
  });

  /**
   * Handle form submission
   */
  const onSubmit = async (data: SetupFormData) => {
    setIsLoading(true);
    setError(null);

    try {
      await authService.setupSuperAdmin(data);
      alert('Super Admin успешно создан!');
      navigate('/login', { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка при создании Super Admin';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4">
      {/* Background decoration */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/2 -left-1/2 w-full h-full bg-gradient-to-br from-purple-500/10 via-transparent to-transparent rounded-full blur-3xl" />
        <div className="absolute -bottom-1/2 -right-1/2 w-full h-full bg-gradient-to-tl from-blue-500/10 via-transparent to-transparent rounded-full blur-3xl" />
      </div>

      <Card className="relative w-full max-w-[420px] border-slate-800/60 bg-slate-900/60 backdrop-blur-xl shadow-2xl">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-blue-500 shadow-lg shadow-purple-500/25">
            <Shield className="h-6 w-6 text-white" />
          </div>
          <CardTitle className="text-2xl font-bold text-white">
            Первоначальная настройка
          </CardTitle>
          <CardDescription className="text-slate-400">
            Создание первого Super Admin пользователя
          </CardDescription>
        </CardHeader>

        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4 border-red-500/50 bg-red-500/10">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username" className="text-slate-200">
                Имя пользователя
              </Label>
              <Input
                id="username"
                type="text"
                placeholder="Введите имя пользователя"
                autoComplete="username"
                aria-invalid={errors.username ? 'true' : 'false'}
                aria-describedby={errors.username ? 'username-error' : undefined}
                className="h-11 bg-slate-800/50 border-slate-700 text-white placeholder:text-slate-500 focus:border-purple-500 focus:ring-purple-500/20"
                {...register('username')}
              />
              {errors.username && (
                <p id="username-error" className="text-xs text-red-400">
                  {errors.username.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-slate-200">
                Пароль
              </Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                autoComplete="new-password"
                aria-invalid={errors.password ? 'true' : 'false'}
                aria-describedby={errors.password ? 'password-error' : undefined}
                className="h-11 bg-slate-800/50 border-slate-700 text-white placeholder:text-slate-500 focus:border-purple-500 focus:ring-purple-500/20"
                {...register('password')}
              />
              {errors.password && (
                <p id="password-error" className="text-xs text-red-400">
                  {errors.password.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="telegramId" className="text-slate-200">
                Telegram ID
              </Label>
              <Input
                id="telegramId"
                type="text"
                placeholder="Из .env SUPER_ADMIN_TELEGRAM_ID"
                aria-invalid={errors.telegramId ? 'true' : 'false'}
                aria-describedby={errors.telegramId ? 'telegramId-error' : undefined}
                className="h-11 bg-slate-800/50 border-slate-700 text-white placeholder:text-slate-500 focus:border-purple-500 focus:ring-purple-500/20"
                {...register('telegramId')}
              />
              {errors.telegramId && (
                <p id="telegramId-error" className="text-xs text-red-400">
                  {errors.telegramId.message}
                </p>
              )}
            </div>

            <Button
              type="submit"
              disabled={isLoading}
              className="w-full h-11 bg-gradient-to-r from-purple-600 to-blue-500 hover:from-purple-500 hover:to-blue-400 text-white font-medium transition-all duration-200 hover:shadow-lg hover:shadow-purple-500/25"
              aria-label="Создать Super Admin"
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  Создание...
                </>
              ) : (
                'Создать Super Admin'
              )}
            </Button>
          </form>

          <div className="mt-4 p-3 rounded-lg bg-slate-800/50 border border-slate-700/50">
            <p className="text-xs text-slate-400">
              <strong className="text-slate-300">Важно:</strong> Telegram ID должен совпадать со значением{' '}
              <code className="bg-slate-700 px-1 py-0.5 rounded text-slate-300">SUPER_ADMIN_TELEGRAM_ID</code>{' '}
              из переменных окружения сервера.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
