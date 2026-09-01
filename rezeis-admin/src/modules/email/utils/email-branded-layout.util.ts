import { EmailBrandingInterface } from '../interfaces/email.interface';

/**
 * The branded shell every outgoing email is wrapped in.
 *
 * -- Why this is a shared function and not a private method -----------------
 *
 * It was private to `EmailTemplateRendererService`, and the broadcast module --
 * the one email a subscriber is most likely to actually read -- did not go
 * through that service at all. So every transactional email arrived in the
 * operator's colours, with their logo and their name, and the broadcast arrived
 * as grey text on white, looking like it came from somewhere else entirely.
 *
 * Extracted rather than copied, because a copy is how the two would drift: the
 * email HTML sanitiser in this repository already spent a release as a correct,
 * well-tested function sitting beside a live call site that never reached it.
 */
export function wrapInBrandedEmailLayout(
  content: string,
  branding: EmailBrandingInterface,
): string {
  const { serviceName, logoUrl, primaryColor, supportEmail, websiteUrl } = branding;
  // The operator's own surfaces. Absent on a settings blob with no theme, and
  // then these are the exact greys the layout has always used — so a deployment
  // that never picked a theme sees no change at all.
  const background = branding.theme?.background ?? '#f4f4f5';
  const surface = branding.theme?.surface ?? '#ffffff';
  const text = branding.theme?.text ?? '#1f2937';
  const muted = branding.theme?.mutedText ?? '#6b7280';
  const onPrimary = branding.theme?.onPrimary ?? '#ffffff';
  // The footer sits on the card, one shade apart. Derived from the ink rather
  // than hard-coded, so it stays legible on a dark surface too.
  const footerBorder = `${muted}33`;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${serviceName}</title>
</head>
<body style="margin:0;padding:0;background-color:${background};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${background};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:${surface};border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background-color:${primaryColor};padding:24px 32px;text-align:center;">
              ${logoUrl ? `<img src="${logoUrl}" alt="${serviceName}" style="max-height:40px;margin-bottom:8px;">` : ''}
              <h1 style="margin:0;color:${onPrimary};font-size:20px;font-weight:600;">${serviceName}</h1>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding:32px;font-size:15px;line-height:1.6;color:${text};">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:16px 32px;background-color:${surface};border-top:1px solid ${footerBorder};text-align:center;font-size:12px;color:${muted};">
              <p style="margin:0 0 4px 0;">${serviceName}</p>
              ${websiteUrl ? `<p style="margin:0 0 4px 0;"><a href="${websiteUrl}" style="color:${primaryColor};text-decoration:none;">${websiteUrl}</a></p>` : ''}
              ${supportEmail ? `<p style="margin:0;"><a href="mailto:${supportEmail}" style="color:${primaryColor};text-decoration:none;">${supportEmail}</a></p>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
