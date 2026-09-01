/**
 * Renders the operator's broadcast body as HTML fit for an inbox.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The email body used to be built by escaping `<` and `>` outright. The compose
 * form tells the operator "supports HTML: <b>bold</b>, <i>italic</i>, <a>", and
 * Telegram renders exactly that — so the same broadcast arrived formatted in
 * Telegram and as literal `<b>bold</b>` characters in the inbox. That is the
 * reported "HTML did not work in the email".
 *
 * ── Why not simply stop escaping ──────────────────────────────────────────
 *
 * The escape was protecting something real, even if it was protecting it in the
 * wrong place. Authoring a broadcast needs only `broadcasts:create`, an
 * RBAC-scoped operator role — and the output is mass mail leaving under the
 * service's own From address and branding. Passing raw HTML through would hand
 * that role tracking pixels, arbitrary external CSS, and layout that can break
 * out of the branded wrapper.
 *
 * So: escape everything first, then re-enable a known-good set. That order is
 * the point. A parser that tries to strip the bad tags has to be right about
 * every input; this has to be right about a dozen. Anything not on the list —
 * `<script>`, `<img>`, `<style>`, an `onclick=`, a `javascript:` href — stays
 * escaped and is shown as text, which is ugly and safe rather than silent and
 * dangerous.
 */

/** Tags carried through with no attributes at all. */
const PLAIN_TAGS = [
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'code',
  'pre',
  'blockquote',
  'br',
  'p',
] as const;

/** Schemes an `<a href>` may carry. Everything else is left as escaped text. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;

/**
 * An href may not contain whitespace or control characters.
 *
 * A real URL never needs them, and they are how an attribute value gets
 * extended into a second attribute. Escaping already prevents that here, but
 * refusing the shape outright means the guarantee does not rest on the escape
 * being perfect.
 */
const hrefHasSeparator = (value: string): boolean => {
  for (const char of value) {
    // Everything at or below the space, plus DEL. Written as a loop rather than
    // a character class because a regex carrying control characters is the kind
    // of thing a linter rightly objects to, and this reads plainer anyway.
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Escapes text for use inside an HTML attribute value.
 *
 * Separate from {@link escapeHtml} because an attribute also has to survive the
 * quote that delimits it — a `"` in an unescaped href closes the attribute and
 * everything after it becomes markup.
 */
const escapeAttribute = (value: string): string =>
  escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Telegram's custom-emoji wrapper carries the fallback glyph as its text, so
 * unwrapping it keeps the emoji and drops the markup no mail client understands.
 */
const unwrapTgEmoji = (value: string): string =>
  value.replace(/&lt;tg-emoji[^&]*?&gt;([\s\S]*?)&lt;\/tg-emoji&gt;/gi, '$1');

export function renderOperatorHtml(raw: string): string {
  const escaped = unwrapTgEmoji(escapeHtml(raw));

  const plain = new RegExp(`&lt;(/?)(${PLAIN_TAGS.join('|')})\\s*/?&gt;`, 'gi');
  let out = escaped.replace(plain, (_whole, slash: string, tag: string) => {
    const name = tag.toLowerCase();
    return name === 'br' && slash === '' ? '<br>' : `<${slash}${name}>`;
  });

  // ── Anchors, PAIRED IN ORDER ────────────────────────────────────────
  //
  // Openers and closers are matched in one pass so a closer belongs to the
  // opener it follows. Counting them separately — accept N openers, then
  // un-escape the first N closers wherever they fall — gets this wrong the
  // moment a refused anchor precedes an accepted one: the refused anchor's
  // closer becomes real markup and the accepted anchor's stays escaped, so the
  // surviving link is never closed and swallows the entire rest of the email.
  // A root-relative `<a href="/promo">` before a good link is enough to do it.
  let openAnchors = 0;
  out = out.replace(
    /&lt;a\s+href\s*=\s*(?:"|&quot;|')([^"'&<>]*(?:&amp;[^"'&<>]*)*)(?:"|&quot;|')\s*&gt;|&lt;\/a&gt;/gi,
    (whole, href?: string) => {
      if (href === undefined) {
        // A closer with no accepted opener stays text; otherwise it closes one.
        if (openAnchors === 0) return whole;
        openAnchors -= 1;
        return '</a>';
      }
      const plainHref = href.replace(/&amp;/g, '&');
      if (!SAFE_HREF.test(plainHref) || hrefHasSeparator(plainHref)) return whole;
      openAnchors += 1;
      return `<a href="${escapeAttribute(plainHref)}" target="_blank" rel="noopener noreferrer">`;
    },
  );

  // Line breaks last, so a `\n` inside markup the operator wrote still shows.
  return out.replace(/\r\n|\r|\n/g, '<br>');
}

/**
 * The full email body: an optional heading plus the rendered text.
 *
 * The TITLE is escaped without exception. It is plain text by contract — the
 * Telegram composer escapes it too — and it is also the email subject, where
 * markup has nowhere to render.
 */
/**
 * One custom emoji, as an email can show it.
 *
 * `imageUrl` is ABSOLUTE — resolved by the caller against the operator's public
 * site, because a stored `/uploads/emoji/x.webp` means nothing to a mail client
 * with no origin to resolve it against.
 */
export interface EmailEmojiInterface {
  readonly imageUrl: string | null;
  readonly fallback: string;
}

/**
 * Replace the operator's `:slug:` shortcodes with something an inbox can draw.
 *
 * ── Why an image and not just the glyph ───────────────────────────────────
 *
 * A premium Telegram custom emoji is a lottie animation, addressed by id and
 * drawn by Telegram's own client: there is no format to put in an email and no
 * public url either. But these emoji were imported INTO the panel, and the
 * import stores a static picture of each one — which every mail client can
 * render, and which is what the reader actually recognises.
 *
 * ── Why the glyph is still the alt ────────────────────────────────────────
 *
 * Most clients block remote images until the reader allows them, and some
 * deployments will not serve the asset at all. `alt` makes both of those
 * degrade to exactly the previous behaviour — the plain glyph — instead of a
 * broken-image box.
 *
 * ── Why this runs AFTER the sanitiser ─────────────────────────────────────
 *
 * `<img>` is deliberately not on the allow-list: an operator-authored image tag
 * is a tracking pixel with extra steps. These tags are not operator input —
 * they are built here from the panel's own emoji records, on text that has
 * already been escaped — so the allow-list stays closed and the pictures still
 * get through.
 */
export function substituteEmailEmoji(
  safeHtml: string,
  emoji: ReadonlyMap<string, EmailEmojiInterface>,
): string {
  if (emoji.size === 0) return safeHtml;
  return safeHtml.replace(/:([a-z0-9_]+):/g, (whole, slug: string) => {
    const entry = emoji.get(slug);
    if (entry === undefined) return whole;
    const glyph = escapeHtml(entry.fallback);
    if (entry.imageUrl === null) return glyph.length > 0 ? glyph : whole;
    return (
      `<img src="${escapeAttribute(entry.imageUrl)}" alt="${escapeAttribute(entry.fallback)}"` +
      ' width="20" height="20" style="vertical-align:-4px;display:inline-block;">'
    );
  });
}

export function renderBroadcastEmailHtml(
  title: string | null,
  text: string,
  emoji?: ReadonlyMap<string, EmailEmojiInterface>,
): string {
  const trimmedTitle = title?.trim() ?? '';
  // ── NO COLOURS OF ITS OWN ─────────────────────────────────────────────
  //
  // The heading and body used to pin `#111827` and `#374151`. That was
  // invisible the moment the surrounding card stopped being white — which is
  // exactly what happens now that the layout follows the operator's cabinet
  // theme: a dark card would have carried near-black text on near-black.
  // Inheriting means one place decides the ink, and it is the place that knows
  // what the card is.
  const escapedTitle = escapeHtml(trimmedTitle);
  const headingHtml =
    trimmedTitle.length > 0
      ? `<h2 style="margin:0 0 16px 0;font-size:20px;">${
          emoji === undefined ? escapedTitle : substituteEmailEmoji(escapedTitle, emoji)
        }</h2>`
      : '';
  const bodyHtml =
    emoji === undefined
      ? renderOperatorHtml(text)
      : substituteEmailEmoji(renderOperatorHtml(text), emoji);
  return `${headingHtml}<div style="font-size:15px;line-height:1.6;">${bodyHtml}</div>`;
}

/**
 * A plain-text alternative for the same body.
 *
 * Sent alongside the HTML part: a message with no text alternative scores worse
 * with spam filters, and a reader whose client refuses HTML currently gets
 * nothing at all.
 */
export function renderBroadcastEmailText(title: string | null, text: string): string {
  const stripped = text
    .replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/gi, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  const trimmedTitle = title?.trim() ?? '';
  return trimmedTitle.length > 0 ? `${trimmedTitle}\n\n${stripped}` : stripped;
}
