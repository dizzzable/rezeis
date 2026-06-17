# Bot Emoji Studio

One place in the admin panel to manage every semantic emoji slot the bot uses,
its fallback glyph, the premium custom emoji bound to it, and the screens/blocks
that reference it. Lives on the **Emoji packs** page (`/emoji-packs`) under the
**Slots** tab; the **Packs** tab keeps the existing pack import/management.

## Two emoji systems (unchanged on-wire format)

The bot copy goes through two additive token systems — both stored as text,
resolved at delivery time by reiwa's `renderBotCopy`:

| Token        | Source of truth                                              | Rendered as |
|--------------|--------------------------------------------------------------|-------------|
| `{{KEY}}`    | `BotEmoji` registry (`key`, `unicode`, `tgEmojiId`)          | unicode glyph, upgraded to a Telegram premium custom-emoji when `tgEmojiId` is set |
| `:slug:`     | `Settings.systemNotifications.customEmojiPacks[].emojis[]`    | pack `fallback` glyph, upgraded to premium when `customEmojiId` is set |

The Studio reads both: each `BotEmoji` slot is a row, and its `tgEmojiId` is
joined back to the imported pack emoji it came from to show a live preview
(image / Lottie / video) instead of a raw id.

## What you can do per slot

- **Fallback** — edit the unicode glyph (`unicode`). Always shown when premium
  can't render.
- **Premium** — pick a custom emoji from the imported packs (no raw ids to
  paste); binds the pack emoji's `customEmojiId` into the slot's `tgEmojiId`.
  Clear it to fall back to unicode.
- **Used in** — read-only badges listing the code sites (mini-profile, trial
  button, status/traffic, …) plus a scan of operator bot-texts for the slot's
  `{{KEY}}` / `:slug:`.

## Owner-premium flag

Telegram only renders premium custom emoji in a bot's messages when the **bot
owner's account has Telegram Premium**. If it does not, a message carrying
`custom_emoji` entities is rejected.

- Flag: `Settings.systemNotifications.botEmoji.ownerHasPremium` (default `true`).
- Edited from the Studio banner toggle (`PUT /admin/bot-config/emoji-studio/owner-premium`,
  RBAC `bot_config.edit`, audited as `bot_config.emoji.ownerPremium`).
- Projected to reiwa as `botEmojiOwnerHasPremium` in the internal bot-config
  payload.
- When `false`, reiwa runs `stripCustomEmojiEntities` as a final pass over every
  rendered message: the fallback glyphs stay as plain text, only the premium
  entities are dropped — so messages always send.

## Endpoints

- `GET /admin/bot-config/emoji-studio` (`bot_config.view`) →
  `{ slots: [{ id, key, unicode, tgEmojiId, premiumPreview, usedIn[] }], ownerHasPremium }`
- `PUT /admin/bot-config/emoji-studio/owner-premium` (`bot_config.edit`) →
  `{ ownerHasPremium }`
- Slot edits reuse `PATCH /admin/bot-config/emojis/:id` (`unicode`, `tgEmojiId`).

## No new env

Everything rides existing config: the `BotEmoji` table and the
`Settings.systemNotifications` JSON. No migration was needed for the studio or
the owner-premium flag.
