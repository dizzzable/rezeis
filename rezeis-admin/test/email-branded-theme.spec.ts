import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { wrapInBrandedEmailLayout } from '../src/modules/email/utils/email-branded-layout.util';
import { emailThemeFromBranding, luminanceOf } from '../src/modules/email/utils/email-theme.util';
import { DEFAULT_BRANDING } from '../src/modules/settings/interfaces/branding-settings.interface';

/**
 * An email should look like the cabinet it came from.
 *
 * It already carried the brand's NAME, LOGO and ACCENT — and then framed them
 * in a fixed light-grey card with near-black text. So an operator running a
 * dark cabinet sent mail that looked like a different product, and the one
 * thing that did follow their settings, the accent, sat on a shell that did
 * not.
 */

const base = { serviceName: 'Reiwa', logoUrl: null, supportEmail: null, websiteUrl: null };

describe('reading a theme out of the operator branding', () => {
  it('takes the variant the operator set as their default mode', () => {
    const branding = {
      ...DEFAULT_BRANDING,
      themeDefaultMode: 'light' as const,
      themeVariants: {
        light: { ...DEFAULT_BRANDING, bgPrimary: '#ffffff', bgSecondary: '#f5f5f5' },
        dark: { ...DEFAULT_BRANDING, bgPrimary: '#000000', bgSecondary: '#111111' },
      },
    } as never;

    assert.equal(emailThemeFromBranding(branding).surface, '#f5f5f5');
  });

  it('falls back to the root colours when there are no variants', () => {
    // A custom or legacy theme has `themeVariants: null`, and then the
    // root-level colours ARE the theme. Treating that as "no theme" would send
    // those operators the generic card their cabinet does not look like.
    const branding = {
      ...DEFAULT_BRANDING,
      themeVariants: null,
      bgPrimary: '#101010',
      bgSecondary: '#1c1c1c',
    } as never;

    assert.equal(emailThemeFromBranding(branding).surface, '#1c1c1c');
  });
});

describe('the ink is measured against the surface, not assumed', () => {
  it('goes light on a dark card', () => {
    // The whole reason this is computed: a hard-coded #1f2937 on a dark card is
    // black on black, and the operator most likely to hit it is the one who
    // deliberately chose a dark theme.
    const theme = emailThemeFromBranding({
      ...DEFAULT_BRANDING,
      themeVariants: null,
      bgSecondary: '#0a0a0a',
    } as never);

    assert.ok((luminanceOf(theme.text) ?? 0) > 0.5, `text is not light: ${theme.text}`);
  });

  it('stays dark on a light card', () => {
    const theme = emailThemeFromBranding({
      ...DEFAULT_BRANDING,
      themeVariants: null,
      bgSecondary: '#ffffff',
    } as never);

    assert.ok((luminanceOf(theme.text) ?? 1) < 0.2, `text is not dark: ${theme.text}`);
  });

  it('treats a colour it cannot read as light, which is what it always was', () => {
    // Gradients and css variables land here. Guessing "dark" would turn every
    // one of those deployments white-on-white overnight.
    const theme = emailThemeFromBranding({
      ...DEFAULT_BRANDING,
      themeVariants: null,
      bgSecondary: 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)',
    } as never);

    assert.equal(theme.text, '#1f2937');
  });
});

describe('the layout paints what the theme says', () => {
  it('uses the operator surfaces', () => {
    const html = wrapInBrandedEmailLayout('<p>hello</p>', {
      ...base,
      primaryColor: '#22c55e',
      theme: {
        background: '#0a0a0a',
        surface: '#171717',
        text: '#f4f4f5',
        mutedText: '#a1a1aa',
        onPrimary: '#0a0a0a',
      },
    });

    assert.ok(html.includes('background-color:#0a0a0a'), 'the page ground is not the theme');
    assert.ok(html.includes('background-color:#171717'), 'the card is not the theme');
    assert.ok(html.includes('color:#f4f4f5'), 'the ink is not the theme');
    assert.ok(html.includes('color:#0a0a0a;font-size:20px'), 'the header text is not the theme');
  });

  it('renders exactly the old greys when there is no theme at all', () => {
    // The safety property. A deployment whose settings blob predates this must
    // see no change whatsoever.
    const html = wrapInBrandedEmailLayout('<p>hello</p>', { ...base, primaryColor: '#22c55e' });

    assert.ok(html.includes('background-color:#f4f4f5'));
    assert.ok(html.includes('background-color:#ffffff'));
    assert.ok(html.includes('color:#1f2937'));
  });
});
