import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/test-utils'
import { ConfidenceExplainer } from './confidence-explainer'

/**
 * A confidence an operator cannot account for is a number they will either
 * over-trust or ignore. The detector writes its whole derivation into the
 * signal metadata; this is the part that makes it readable.
 */
describe('ConfidenceExplainer', () => {
  afterEach(cleanup)

  const HWID_METADATA = {
    kind: 'hwid_overage',
    deviceCount: 9,
    deviceLimit: 2,
    confidenceBaseline: 5,
    confidenceCeiling: 65,
    confidenceAgreement: 0.75,
    confidenceDataQuality: 1,
    confidenceFactors: {
      overageRatio: { observed: 1.8, strength: 0.4 },
      overageSurplus: { observed: 4, strength: 0.75 },
    },
  }

  it('shows the product the confidence came out of', () => {
    renderWithProviders(<ConfidenceExplainer confidence={48} metadata={HWID_METADATA} />)

    expect(
      screen.getByText(
        '48% = 65 (detector ceiling) × 0.75 (agreement) × 1 (data quality)',
      ),
    ).toBeInTheDocument()
  })

  // The factor keys are the identifiers the detector documents at the site it
  // computes them, so they are shown verbatim — a translated label could not be
  // grepped for when somebody asks "where does overageSurplus come from?".
  it('lists each factor with what was observed and how much it counted', () => {
    renderWithProviders(<ConfidenceExplainer confidence={48} metadata={HWID_METADATA} />)

    expect(screen.getByText('overageRatio')).toBeInTheDocument()
    expect(screen.getByText('1.8 → 0.4')).toBeInTheDocument()
    expect(screen.getByText('overageSurplus')).toBeInTheDocument()
    expect(screen.getByText('4 → 0.75')).toBeInTheDocument()
  })

  // Rows written before this model existed, and any code that does not use it,
  // must keep exactly the drilldown they had rather than gaining an empty box.
  it('renders nothing for a signal that carries no derivation', () => {
    const { container } = renderWithProviders(
      <ConfidenceExplainer confidence={80} metadata={{ kind: 'hwid_overage', deviceCount: 9 }} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('survives a metadata payload whose confidence keys are the wrong shape', () => {
    renderWithProviders(
      <ConfidenceExplainer
        confidence={40}
        metadata={{
          confidenceCeiling: 60,
          confidenceAgreement: 0.67,
          confidenceDataQuality: 1,
          confidenceFactors: {
            good: { observed: 2, strength: 0.5 },
            broken: 'not an object',
            alsoBroken: { observed: 'seven' },
          },
        }}
      />,
    )
    // The readable factor survives; the malformed ones are skipped rather than
    // taking the drilldown down with them.
    expect(screen.getByText('good')).toBeInTheDocument()
    expect(screen.getByText('2 → 0.5')).toBeInTheDocument()
    expect(screen.queryByText('broken')).toBeNull()
    expect(screen.queryByText('alsoBroken')).toBeNull()
  })
})
