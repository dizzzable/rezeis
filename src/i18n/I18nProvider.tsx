import { useEffect } from 'react';
import { useAuth } from '@/stores/auth.store';
import i18n from './index';

/**
 * Props for I18nProvider component
 */
interface I18nProviderProps {
  /** Child components */
  children: React.ReactNode;
}

/**
 * Provider component for i18n language synchronization
 * Syncs language with server user data
 */
export function I18nProvider({ children }: I18nProviderProps) {
  const { user } = useAuth();

  /**
   * Synchronize language with server user data
   */
  useEffect(() => {
    if (user?.language) {
      void i18n.changeLanguage(user.language);
    }
  }, [user?.language]);

  return <>{children}</>;
}