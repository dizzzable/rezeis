import type { ComponentType } from 'react'

import type { LandingSection, LandingSectionType } from '../landing-builder-api'
import {
  CtaBanner,
  Faq,
  FeaturesGrid,
  Footer,
  Hero,
  HowItWorks,
  Pricing,
  Stats,
  Testimonials,
  TrustLogos,
} from './preview-sections'

interface SectionProps {
  section: LandingSection
  locale: string
  defaultLocale: string
  primaryColor: string
}

/** Fixed registry for the same ten section types as the canonical schema. */
export const PREVIEW_SECTIONS: Record<LandingSectionType, ComponentType<SectionProps>> = {
  hero: Hero,
  featuresGrid: FeaturesGrid,
  howItWorks: HowItWorks,
  pricing: Pricing,
  faq: Faq,
  testimonials: Testimonials,
  stats: Stats,
  trustLogos: TrustLogos,
  ctaBanner: CtaBanner,
  footer: Footer,
}
