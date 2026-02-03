import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAuthStore, useAuth } from '@/stores/auth.store';
import { authService } from '@/api/auth.service';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, AlertCircle, Send, User } from 'lucide-react';

/**
 * Login form validation schema
 */
const loginSchema = z.object({
  username: z.string().min(3, 'Имя пользователя должно быть не менее 3 символов'),
  password: z.string().min(6, 'Пароль должен быть не менее 6 символов'),
});

/**
 * Login form data type
 */
type LoginFormData = z.infer<typeof loginSchema>;

/**
 * Telegram logo SVG component
 */
function TelegramLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

/**
 * Login page component with Telegram and Email authentication
 */
export default function Login() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading, error } = useAuth();
  const { loginWithTelegram, loginWithEmail, clearError } = useAuthStore(
    (state) => ({
      loginWithTelegram: state.loginWithTelegram,
      loginWithEmail: state.loginWithEmail,
      clearError: state.clearError,
    })
  );

  const [activeTab, setActiveTab] = useState<'telegram' | 'email'>('telegram');
  const [isTelegramWebApp, setIsTelegramWebApp] = useState(false);
  const [telegramLoginAttempted, setTelegramLoginAttempted] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  });

  /**
   * Handle Telegram WebApp login
   */
  const handleTelegramLogin = useCallback(async (initData: string) => {
    try {
      await loginWithTelegram({ initData });
      navigate('/dashboard', { replace: true });
    } catch {
      // Error is already set in the store
    }
  }, [loginWithTelegram, navigate]);

  /**
   * Check if running inside Telegram WebApp and auto-login
   */
  useEffect(() => {
    const checkTelegramWebApp = () => {
      const hasTelegramWebApp = !!window.Telegram?.WebApp;
      setIsTelegramWebApp(hasTelegramWebApp);

      if (hasTelegramWebApp && window.Telegram) {
        // Notify Telegram that the WebApp is ready
        window.Telegram.WebApp.ready();

        // Try auto-login if initData is available and not already attempted
        const initData = window.Telegram.WebApp.initData;
        if (initData && !telegramLoginAttempted) {
          setTelegramLoginAttempted(true);
          handleTelegramLogin(initData);
        }
      }
    };

    checkTelegramWebApp();
  }, [telegramLoginAttempted, handleTelegramLogin]);

  /**
   * Redirect to dashboard if already authenticated
   */
  useEffect(() => {
    if (isAuthenticated) {
      navigate('/dashboard', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  /**
   * Check if setup is required on mount
   */
  useEffect(() => {
    const checkSetup = async () => {
      try {
        const needsSetup = await authService.checkSetupStatus();
        if (needsSetup) {
          navigate('/setup', { replace: true });
        }
      } catch {
        // If check fails, continue to login page
      }
    };

    checkSetup();
  }, [navigate]);

  /**
   * Clear errors when switching tabs
   */
  useEffect(() => {
    clearError();
  }, [activeTab, clearError]);

  /**
   * Handle manual Telegram login click
   */
  const handleTelegramButtonClick = () => {
    if (isTelegramWebApp && window.Telegram?.WebApp.initData) {
      handleTelegramLogin(window.Telegram.WebApp.initData);
    } else {
      // Open Telegram bot link for external browser users
      const botUsername = 'rezeis_bot'; // Replace with actual bot username
      const webAppUrl = encodeURIComponent(window.location.origin);
      window.open(
        `https://t.me/${botUsername}?startapp=${webAppUrl}`,
        '_blank'
      );
    }
  };

  /**
   * Handle email form submission
   */
  const onEmailSubmit = async (data: LoginFormData) => {
    try {
      await loginWithEmail({ credentials: data });
      navigate('/dashboard', { replace: true });
    } catch {
      // Error is already set in the store
    }
  };

  const handleTabChange = (value: string) => {
    setActiveTab(value as 'telegram' | 'email');
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4">
      {/* Background decoration */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/2 -left-1/2 w-full h-full bg-gradient-to-br from-blue-500/10 via-transparent to-transparent rounded-full blur-3xl" />
        <div className="absolute -bottom-1/2 -right-1/2 w-full h-full bg-gradient-to-tl from-cyan-500/10 via-transparent to-transparent rounded-full blur-3xl" />
      </div>

      <Card className="relative w-full max-w-[420px] border-slate-800/60 bg-slate-900/60 backdrop-blur-xl shadow-2xl">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400 shadow-lg shadow-blue-500/25">
            <span className="text-xl font-bold text-white">R</span>
          </div>
          <CardTitle className="text-2xl font-bold text-white">
            Rezeis Panel
          </CardTitle>
          <CardDescription className="text-slate-400">
            Войдите в админ-панель VPN сервиса
          </CardDescription>
        </CardHeader>

        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4 border-red-500/50 bg-red-500/10">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Tabs
            value={activeTab}
            onValueChange={handleTabChange}
            className="w-full"
          >
            <TabsList className="grid w-full grid-cols-2 bg-slate-800/50">
              <TabsTrigger
                value="telegram"
                className="data-[state=active]:bg-slate-700 data-[state=active]:text-white"
              >
                <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                Telegram
              </TabsTrigger>
              <TabsTrigger
                value="email"
                className="data-[state=active]:bg-slate-700 data-[state=active]:text-white"
              >
                <User className="mr-2 h-4 w-4" aria-hidden="true" />
                Username
              </TabsTrigger>
            </TabsList>

            <TabsContent value="telegram" className="mt-4 space-y-4">
              <div className="space-y-4">
                {isTelegramWebApp ? (
                  <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 p-4 text-center">
                    <p className="text-sm text-blue-200">
                      Вы открыли приложение через Telegram
                    </p>
                    <p className="text-xs text-blue-300/70 mt-1">
                      Авторизация произойдет автоматически
                    </p>
                  </div>
                ) : (
                  <div className="rounded-lg bg-slate-800/50 p-4 text-center">
                    <p className="text-sm text-slate-300">
                      Откройте эту страницу через Telegram WebApp
                    </p>
                    <p className="text-xs text-slate-400 mt-1">
                      или войдите через бота
                    </p>
                  </div>
                )}

                <Button
                  onClick={handleTelegramButtonClick}
                  disabled={isLoading}
                  className="w-full h-11 bg-[#0088cc] hover:bg-[#0088cc]/90 text-white font-medium transition-all duration-200 hover:shadow-lg hover:shadow-[#0088cc]/25"
                  aria-label="Войти через Telegram"
                >
                  {isLoading && activeTab === 'telegram' ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      Вход...
                    </>
                  ) : (
                    <>
                      <TelegramLogo className="mr-2 h-5 w-5" />
                      Войти через Telegram
                    </>
                  )}
                </Button>

                {!isTelegramWebApp && (
                  <p className="text-xs text-center text-slate-500">
                    Нажмите кнопку для открытия бота в Telegram
                  </p>
                )}
              </div>
            </TabsContent>

            <TabsContent value="email" className="mt-4">
              <form onSubmit={handleSubmit(onEmailSubmit)} className="space-y-4">
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
                    className="h-11 bg-slate-800/50 border-slate-700 text-white placeholder:text-slate-500 focus:border-blue-500 focus:ring-blue-500/20"
                    {...register('username')}
                  />
                  {errors.username && (
                    <p id="username-error" className="text-xs text-red-400">
                      {errors.username.message}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password" className="text-slate-200">
                      Пароль
                    </Label>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-xs text-blue-400 hover:text-blue-300"
                      onClick={() => navigate('/forgot-password')}
                    >
                      Забыли пароль?
                    </Button>
                  </div>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    autoComplete="current-password"
                    aria-invalid={errors.password ? 'true' : 'false'}
                    aria-describedby={errors.password ? 'password-error' : undefined}
                    className="h-11 bg-slate-800/50 border-slate-700 text-white placeholder:text-slate-500 focus:border-blue-500 focus:ring-blue-500/20"
                    {...register('password')}
                  />
                  {errors.password && (
                    <p id="password-error" className="text-xs text-red-400">
                      {errors.password.message}
                    </p>
                  )}
                </div>

                <Button
                  type="submit"
                  disabled={isLoading}
                  className="w-full h-11 bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white font-medium transition-all duration-200 hover:shadow-lg hover:shadow-blue-500/25"
                  aria-label="Войти"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      Вход...
                    </>
                  ) : (
                    'Войти'
                  )}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>

        <CardFooter className="flex flex-col gap-2 text-center">
          <p className="text-xs text-slate-500">
            Используя сервис, вы соглашаетесь с{' '}
            <Button
              variant="link"
              className="h-auto p-0 text-xs text-slate-400 hover:text-slate-300"
              onClick={() => navigate('/terms')}
            >
              условиями использования
            </Button>
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
