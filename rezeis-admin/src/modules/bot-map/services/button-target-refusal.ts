import { BadRequestException } from '@nestjs/common';

import { buttonTargetProblem, type ButtonTargetPlace, type ButtonTargetProblem } from './menu-button-route';

/**
 * Why a button's target is refused, in words the SPA shows as they come —
 * `{field}` is the field that holds it (`actionTarget` of a main-menu button,
 * `url` / `webAppUrl` of a screen's, `buttons[2].target` of a notification's).
 *
 * None repeats the target: the admin exception filter blanks a message that
 * carries an address (`admin-safe-exception.filter.ts`, `https?://\S+` — so no
 * character right after a `://` here either), and the operator knows what they
 * typed. The SPA's forms say the same before the request, in the panel's
 * language (`botConfigPage.buttons.fields.actionTarget.problems.*`); these are
 * for a request that reaches the server anyway.
 */
export const BUTTON_TARGET_PROBLEM_MESSAGES: Readonly<Record<ButtonTargetProblem, string>> = {
  notAPage:
    '{field} must be a page of the cabinet (such as /plans) or a whole address starting with http:// or https://',
  badCharacters: '{field} must not contain spaces, backslashes, control or invisible formatting characters',
  notAnAddress: '{field} must be a whole address: http:// or https:// then a site name, with no spaces',
  webAppNeedsHttps: '{field} for WEBAPP buttons must use https:// (Telegram refuses non-HTTPS web_app)',
  upperCaseScheme:
    '{field} for WEBAPP buttons must start with https:// in lower case: the bot leaves out one that starts with Https:// or HTTPS:// instead',
  localAddress: '{field} must not point at localhost or 127.0.0.1: Telegram refuses such an address',
  linkNeedsHttps: '{field} must start with https:// here: the bot leaves out a link that starts with http:// instead',
  pageOnly:
    '{field} must be a page of the cabinet (such as /plans): the bot opens an address here as a page the cabinet does not have',
  addressOnly: '{field} must be a whole address starting with https:// here: a page of the cabinet opens from a Mini App button',
};

/** The words for `problem`, about `field`. */
export function buttonTargetRefusal(problem: ButtonTargetProblem, field: string): string {
  return BUTTON_TARGET_PROBLEM_MESSAGES[problem].replace('{field}', field);
}

/**
 * Refuse a button's target the bot could not open where `place` reads it —
 * the rule of «Карта бота» (`buttonTargetProblem`), the one the SPA's forms
 * apply before saving. A target that passes is left to the caller to store.
 */
export function assertButtonTarget(place: ButtonTargetPlace, target: string | null | undefined, field: string): void {
  const problem = buttonTargetProblem(place, target ?? null);
  if (problem !== null) throw new BadRequestException(buttonTargetRefusal(problem, field));
}
