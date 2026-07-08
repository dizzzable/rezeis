/**
 * One-click landing templates. Each is a complete `{ theme, sections }` bundle
 * with ru+en filler text so the page renders (and can be published) right after
 * it's applied. A template combines a background effect + palette + radius +
 * surface style + per-section reveal animations — the same fields the operator
 * can then tweak individually. Applying a template REPLACES the current theme
 * and sections (guarded by a confirm dialog in the UI).
 *
 * Palettes are drawn from the VPN-oriented dark schemes gathered during design
 * research (Cyber Cyan / Secure Emerald / Violet Nebula / Signal Orange).
 */
import type {
  LandingAnimation,
  LandingBackground,
  LandingSection,
  LandingSurfaceStyle,
  LandingTheme,
} from './landing-builder-api'

export interface LandingTemplate {
  id: string
  /** i18n key suffix under landingBuilderPage.templates.<id> */
  labelKey: string
  theme: LandingTheme
  sections: Omit<LandingSection, 'id'>[]
}

type L = { ru: string; en: string }
const t = (ru: string, en: string): L => ({ ru, en })

function baseSections(opts: {
  animation: LandingAnimation
  hero: { eyebrow: L; heading: L; sub: L; cta: L }
  features: { heading: L; items: Array<{ icon: string; title: L; body: L }> }
  pricingHeading: L
  faq: { heading: L; items: Array<{ q: L; a: L }> }
  cta: { heading: L; body: L; label: L }
}): Omit<LandingSection, 'id'>[] {
  return [
    {
      type: 'hero',
      visible: true,
      animation: opts.animation,
      data: {
        eyebrow: opts.hero.eyebrow,
        heading: opts.hero.heading,
        subheading: opts.hero.sub,
        primaryCta: { label: opts.hero.cta, action: 'register' },
        align: 'center',
      },
    },
    {
      type: 'featuresGrid',
      visible: true,
      animation: opts.animation,
      data: { heading: opts.features.heading, columns: 3, items: opts.features.items },
    },
    {
      type: 'pricing',
      visible: true,
      animation: opts.animation,
      data: { source: 'catalog', billingToggle: false, heading: opts.pricingHeading },
    },
    {
      type: 'faq',
      visible: true,
      animation: opts.animation,
      data: { heading: opts.faq.heading, items: opts.faq.items.map((i) => ({ question: i.q, answer: i.a })) },
    },
    {
      type: 'ctaBanner',
      visible: true,
      animation: opts.animation,
      data: {
        heading: opts.cta.heading,
        body: opts.cta.body,
        cta: { label: opts.cta.label, action: 'register' },
        style: 'gradient',
      },
    },
    {
      type: 'footer',
      visible: true,
      data: {
        columns: [{ title: t('Продукт', 'Product'), links: [] }],
        legal: t('© Все права защищены', '© All rights reserved'),
      },
    },
  ]
}
const commonFeatures = (): Array<{ icon: string; title: L; body: L }> => [
  { icon: 'zap', title: t('Высокая скорость', 'Blazing speed'), body: t('Серверы рядом с вами для минимальных задержек.', 'Servers near you for minimal latency.') },
  { icon: 'shield', title: t('Надёжная защита', 'Strong protection'), body: t('Современное шифрование трафика без логов.', 'Modern no-logs traffic encryption.') },
  { icon: 'globe', title: t('Глобальная сеть', 'Global network'), body: t('Доступ к контенту из любой точки мира.', 'Reach content from anywhere.') },
]

const commonFaq = (): Array<{ q: L; a: L }> => [
  { q: t('Как начать?', 'How do I start?'), a: t('Зарегистрируйтесь и подключитесь за минуту.', 'Sign up and connect in a minute.') },
  { q: t('На скольких устройствах?', 'How many devices?'), a: t('Одна подписка работает на всех ваших устройствах.', 'One subscription covers all your devices.') },
]

function makeTemplate(
  id: string,
  labelKey: string,
  theme: Partial<LandingTheme> & { background: LandingBackground; surfaceStyle: LandingSurfaceStyle },
  animation: LandingAnimation,
  hero: { eyebrow: L; heading: L; sub: L; cta: L },
): LandingTemplate {
  return {
    id,
    labelKey,
    theme: {
      inherit: false,
      animateBackground: true,
      ...theme,
    },
    sections: baseSections({
      animation,
      hero,
      features: { heading: t('Почему мы', 'Why us'), items: commonFeatures() },
      pricingHeading: t('Тарифы', 'Pricing'),
      faq: { heading: t('Частые вопросы', 'FAQ'), items: commonFaq() },
      cta: {
        heading: t('Готовы начать?', 'Ready to start?'),
        body: t('Подключитесь прямо сейчас.', 'Get connected right now.'),
        label: t('Начать', 'Get started'),
      },
    }),
  }
}

export const LANDING_TEMPLATES: LandingTemplate[] = [
  makeTemplate(
    'auroraMinimal',
    'auroraMinimal',
    {
      background: 'aurora',
      surfaceStyle: 'solid',
      radius: 'xl',
      colors: { primary: '#A78BFA', bg: '#0B0714', fg: '#EDE9FE', accent: '#7C3AED' },
      backgroundColors: ['#A78BFA', '#7C3AED'],
    },
    'fadeUp',
    {
      eyebrow: t('VPN нового поколения', 'Next-gen VPN'),
      heading: t('Приватность без компромиссов', 'Privacy without compromise'),
      sub: t('Быстрый и безопасный доступ в интернет из любой точки.', 'Fast, secure internet access from anywhere.'),
      cta: t('Попробовать', 'Try it'),
    },
  ),
  makeTemplate(
    'liquidGlass',
    'liquidGlass',
    {
      background: 'mesh',
      surfaceStyle: 'glass',
      radius: 'lg',
      colors: { primary: '#22D3EE', bg: '#0A0E14', fg: '#E5E7EB', accent: '#3B82F6' },
      backgroundColors: ['#22D3EE', '#3B82F6', '#0A0E14'],
    },
    'fade',
    {
      eyebrow: t('Стекло и свет', 'Glass & light'),
      heading: t('Защита, которую видно', 'Security you can see'),
      sub: t('Прозрачный, современный интерфейс и мощное шифрование.', 'A clean modern interface with powerful encryption.'),
      cta: t('Подключиться', 'Connect'),
    },
  ),
  makeTemplate(
    'boldGradient',
    'boldGradient',
    {
      background: 'gradient',
      surfaceStyle: 'solid',
      radius: 'md',
      colors: { primary: '#FB923C', bg: '#0C0A09', fg: '#FAFAF9', accent: '#F59E0B' },
      backgroundColors: ['#FB923C', '#0C0A09', '#F59E0B'],
    },
    'zoom',
    {
      eyebrow: t('Скорость решает', 'Speed matters'),
      heading: t('Интернет без границ', 'Internet without borders'),
      sub: t('Максимальная скорость и стабильность соединения.', 'Maximum speed and rock-solid stability.'),
      cta: t('Начать сейчас', 'Start now'),
    },
  ),
  makeTemplate(
    'terminalTech',
    'terminalTech',
    {
      background: 'dots',
      surfaceStyle: 'outline',
      radius: 'sm',
      colors: { primary: '#34D399', bg: '#0B0F0D', fg: '#ECFDF5', accent: '#10B981' },
      backgroundColors: ['#34D399'],
    },
    'fadeUp',
    {
      eyebrow: t('Для тех, кто ценит контроль', 'For those who value control'),
      heading: t('Ваш трафик — ваши правила', 'Your traffic, your rules'),
      sub: t('Технологичный VPN с полным контролем над подключением.', 'A tech-forward VPN with full connection control.'),
      cta: t('Развернуть', 'Deploy'),
    },
  ),
]
