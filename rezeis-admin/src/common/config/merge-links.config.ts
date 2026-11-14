import { registerAs } from '@nestjs/config';

interface MergeLinksConfiguration {
  /**
   * Public base of `remnawave-subscription-merge`, without a trailing slash —
   * e.g. `https://stin.cloudre.store/merge`. The cabinet is given
   * `<baseUrl>/<token>` in place of a subscription's own panel URL.
   *
   * `null` switches merged links off completely: no token is minted, no bundle
   * is advertised to the cabinet, and every card keeps the panel's URL. That is
   * the honest state when the service is not deployed, and it is why this is a
   * configuration value rather than a constant.
   */
  readonly baseUrl: string | null;
}

export const mergeLinksConfig = registerAs('mergeLinks', (): MergeLinksConfiguration => {
  const raw = (process.env.MERGE_LINK_BASE_URL ?? '').trim().replace(/\/+$/, '');
  return { baseUrl: raw.length > 0 ? raw : null };
});
