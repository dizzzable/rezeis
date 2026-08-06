/**
 * Why a signal's confidence is the number it is.
 *
 * Detectors no longer report a per-detector constant — the value is
 * `ceiling × agreement × dataQuality`, where agreement is how many of the
 * detector's independent factors actually fired and how hard, and dataQuality
 * is how complete the read behind it was (see `src/modules/anti-fraud/
 * confidence.util.ts`). Every one of those inputs is written into the signal's
 * `metadata`, and this renders them.
 *
 * It exists because the metadata being present is not the same as it being
 * legible. A sharing signal's drilldown goes through a CURATED renderer that
 * shows a handful of known keys and silently drops the rest, so on exactly the
 * detectors whose confidence moves most the derivation would have been invisible
 * — and on the others it was a line of raw JSON. An operator deciding whether to
 * act on "48%" has to be able to see that it is 65 × 0.75, not guess at it.
 *
 * Renders nothing when the keys are absent: signals written before this model
 * existed, and any code that does not use it, keep exactly the drilldown they
 * had.
 */
import { useTranslation } from 'react-i18next';

interface FactorDetail {
  observed: number;
  strength: number;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `{ name: { observed, strength } }`, tolerant of anything else in the slot. */
function readFactors(value: unknown): Array<[string, FactorDetail]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const out: Array<[string, FactorDetail]> = [];
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue;
    const observed = asNumber((raw as Record<string, unknown>).observed);
    const strength = asNumber((raw as Record<string, unknown>).strength);
    if (observed === null || strength === null) continue;
    out.push([name, { observed, strength }]);
  }
  return out;
}

export function ConfidenceExplainer({
  confidence,
  metadata,
}: {
  confidence: number;
  metadata: Record<string, unknown>;
}) {
  const { t } = useTranslation();

  const ceiling = asNumber(metadata.confidenceCeiling);
  const agreement = asNumber(metadata.confidenceAgreement);
  const dataQuality = asNumber(metadata.confidenceDataQuality);
  const factors = readFactors(metadata.confidenceFactors);

  if (ceiling === null || agreement === null || dataQuality === null) return null;

  return (
    <div className="space-y-1 rounded border border-dashed p-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {t('fraudPage.confidence.title')}
      </p>
      <p className="text-xs tabular-nums">
        {t('fraudPage.confidence.formula', {
          confidence,
          ceiling,
          agreement,
          quality: dataQuality,
        })}
      </p>
      {factors.length > 0 && (
        <ul className="space-y-0.5">
          {factors.map(([name, detail]) => (
            <li key={name} className="text-[11px] text-muted-foreground tabular-nums">
              {/* The factor key is the identifier the detector documents at the
                  site it computes it, so it is shown verbatim rather than
                  translated — a translated label could not be grepped for. */}
              <code className="font-mono">{name}</code>{' '}
              {t('fraudPage.confidence.factor', {
                observed: detail.observed,
                strength: detail.strength,
              })}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10px] text-muted-foreground">{t('fraudPage.confidence.note')}</p>
    </div>
  );
}
