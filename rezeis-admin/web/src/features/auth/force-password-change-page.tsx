/**
 * ForcePasswordChangePage
 * ───────────────────────
 * Rendered when the authenticated admin's `mustChangePassword` flag is set.
 *
 * The route is mounted as a sibling of the admin shell and the auth
 * provider redirects here whenever the flag is true. After a successful
 * rotation the auth provider re-fetches the profile, the flag clears, and
 * the user lands on the dashboard.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { changePassword, usePermissionStore } from '@/features/rbac';
import { useAuth } from '@/features/auth/auth-provider';

export default function ForcePasswordChangePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const refreshPermissions = usePermissionStore((s) => s.refreshPermissions);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const tooShort = newPassword.length > 0 && newPassword.length < 8;
  const mismatch =
    confirmPassword.length > 0 && newPassword !== confirmPassword;
  const sameAsCurrent =
    newPassword.length > 0 && newPassword === currentPassword;
  const valid =
    currentPassword.length > 0 &&
    newPassword.length >= 8 &&
    newPassword === confirmPassword &&
    !sameAsCurrent;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      await changePassword({ currentPassword, newPassword });
      toast.success(t('forcePasswordChangePage.success'));
      await refreshPermissions();
      logout();
      navigate('/sign-in', { replace: true });
    } catch (err) {
      const msg = (err as Error).message;
      toast.error(msg.includes('401') ? t('forcePasswordChangePage.invalidCurrent') : msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-muted/20 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            <CardTitle>{t('forcePasswordChangePage.title')}</CardTitle>
          </div>
          <CardDescription>{t('forcePasswordChangePage.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <PasswordField
              id="current-password"
              label={t('forcePasswordChangePage.currentPassword')}
              value={currentPassword}
              onChange={setCurrentPassword}
              show={show}
              autoComplete="current-password"
              onToggleShow={() => setShow((s) => !s)}
            />
            <PasswordField
              id="new-password"
              label={t('forcePasswordChangePage.newPassword')}
              value={newPassword}
              onChange={setNewPassword}
              show={show}
              autoComplete="new-password"
              hint={
                tooShort
                  ? t('forcePasswordChangePage.minLength')
                  : sameAsCurrent
                    ? t('forcePasswordChangePage.mustDiffer')
                    : t('forcePasswordChangePage.minLength')
              }
              error={tooShort || sameAsCurrent}
              onToggleShow={() => setShow((s) => !s)}
            />
            <PasswordField
              id="confirm-password"
              label={t('forcePasswordChangePage.confirmNewPassword')}
              value={confirmPassword}
              onChange={setConfirmPassword}
              show={show}
              autoComplete="new-password"
              hint={mismatch ? t('forcePasswordChangePage.mismatch') : ''}
              error={mismatch}
              onToggleShow={() => setShow((s) => !s)}
            />
            <Button type="submit" className="w-full" disabled={!valid || submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('forcePasswordChangePage.submit')}
            </Button>
            <button
              type="button"
              onClick={() => {
                logout();
                navigate('/sign-in', { replace: true });
              }}
              className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('forcePasswordChangePage.signOutInstead')}
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  show: boolean;
  onToggleShow: () => void;
  autoComplete: string;
  hint?: string;
  error?: boolean;
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  show,
  onToggleShow,
  autoComplete,
  hint,
  error,
}: PasswordFieldProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required
          minLength={1}
          maxLength={128}
          className={error ? 'border-destructive' : undefined}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={onToggleShow}
          aria-label={show ? t('forcePasswordChangePage.hidePassword') : t('forcePasswordChangePage.showPassword')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {hint && (
        <p className={`text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}>
          {hint}
        </p>
      )}
    </div>
  );
}
