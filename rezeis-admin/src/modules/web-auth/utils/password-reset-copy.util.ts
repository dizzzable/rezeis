/**
 * What the customer reads about a password reset, in their language.
 *
 * The panel writes these itself because it is the one that knows the login,
 * the channel and the deadline. They are not operator templates on purpose: a
 * message that carries a live credential must not be editable into one that
 * hides what it is, and must not depend on a template row being seeded.
 */

export type ResetCopyLocale = 'ru' | 'en';

/** `User.language` → the copy's language. Russian unless the user chose English. */
export function resetCopyLocale(language: string | null | undefined): ResetCopyLocale {
  return typeof language === 'string' && language.toUpperCase() === 'EN' ? 'en' : 'ru';
}

/** Minutes left, rounded, never below one. */
export function minutesLeft(expiresAt: Date, now: Date): number {
  return Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / 60_000));
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pluralMinutesRu(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'минуту';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'минуты';
  return 'минут';
}

/** The Telegram message and its button label (HTML parse mode). */
export function telegramResetMessage(input: {
  readonly locale: ResetCopyLocale;
  readonly login: string;
  readonly minutes: number;
}): { readonly text: string; readonly button: string } {
  const login = escapeHtml(input.login);
  if (input.locale === 'en') {
    return {
      text:
        '🔑 <b>Password reset</b>\n\n' +
        `Someone asked to reset the cabinet password for the login <b>${login}</b>.\n\n` +
        'Tap the button below and choose a new password. The link works once and ' +
        `expires in ${input.minutes} ${input.minutes === 1 ? 'minute' : 'minutes'}.\n\n` +
        'If it wasn’t you, ignore this message — your password stays the same.',
      button: 'Set a new password',
    };
  }
  return {
    text:
      '🔑 <b>Сброс пароля</b>\n\n' +
      `Запросили сброс пароля от кабинета для логина <b>${login}</b>.\n\n` +
      'Нажмите кнопку ниже и придумайте новый пароль. Ссылка сработает один раз ' +
      `и действует ${input.minutes} ${pluralMinutesRu(input.minutes)}.\n\n` +
      'Если это были не вы — просто проигнорируйте сообщение, пароль останется прежним.',
    button: 'Задать новый пароль',
  };
}

/** The push shown after a reset by subscription link. */
export function subscriptionResetPushNotice(locale: ResetCopyLocale): {
  readonly title: string;
  readonly body: string;
} {
  if (locale === 'en') {
    return {
      title: 'Password changed',
      body:
        'Your cabinet password was changed using your subscription link. ' +
        'If it wasn’t you, contact support.',
    };
  }
  return {
    title: 'Пароль изменён',
    body:
      'Пароль от кабинета изменён по ссылке подписки. ' +
      'Если это были не вы — напишите в поддержку.',
  };
}
