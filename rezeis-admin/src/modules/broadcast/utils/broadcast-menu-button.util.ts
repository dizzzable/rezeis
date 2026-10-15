/**
 * «Кнопка «Меню» под постом» (the owner, 15.10.2026): a broadcast can carry a
 * «🏠 Главное меню» button that opens the bot's main menu as a NEW message and
 * leaves the post where it is. reiwa answers its callback, `menu:new`, from
 * the cabinet release of 15.10.2026; an older bot answers it as a button it
 * does not know — the menu in place of the post, «Меню обновилось».
 *
 * Unlike the promo button, this one is an ordinary Telegram callback button: it
 * needs nothing only the bot knows (no Mini App url), so it goes out the same
 * on every route — through the relay with a text post, and straight to the Bot
 * API with a photo or a video, and with an edit of either.
 */
import type { NotifyButton } from '../../notifications/services/bot-notifier.client';
import { BROADCAST_MENU_BUTTON_LABEL, BROADCAST_MENU_CALLBACK } from '../broadcast.constants';

/** Whether the stored payload asks for the menu button. Absent — a broadcast from before it — means no. */
export function readMenuButton(payload: Record<string, unknown> | null | undefined): boolean {
  return payload?.menuButton === true;
}

/** The relay's button, on a row below whatever the post already carries. */
export function buildMenuNotifyButton(): NotifyButton {
  return { text: BROADCAST_MENU_BUTTON_LABEL, callbackData: BROADCAST_MENU_CALLBACK };
}

/** The Bot API's `reply_markup` for a post sent or edited straight through the Bot API. */
export function buildMenuInlineKeyboard(): {
  readonly inline_keyboard: ReadonlyArray<ReadonlyArray<{ readonly text: string; readonly callback_data: string }>>;
} {
  return { inline_keyboard: [[{ text: BROADCAST_MENU_BUTTON_LABEL, callback_data: BROADCAST_MENU_CALLBACK }]] };
}
