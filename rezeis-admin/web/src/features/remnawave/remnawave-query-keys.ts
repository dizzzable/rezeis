/**
 * Centralised query-key factory for the Remnawave admin page.
 *
 * All TanStack Query keys live here so cross-tab invalidations
 * (`queryClient.invalidateQueries({ queryKey: KEYS.nodes })` from a host
 * reorder, for example) hit the right cache without typo-driven misses.
 */
export const KEYS = {
  status: ['remnawave', 'status'] as const,
  health: ['remnawave', 'health'] as const,
  stats: ['remnawave', 'stats'] as const,
  recap: ['remnawave', 'recap'] as const,
  bandwidth: ['remnawave', 'bandwidth'] as const,
  nodes: ['remnawave', 'nodes'] as const,
  hosts: ['remnawave', 'hosts'] as const,
  internalSquads: ['remnawave', 'internal-squads'] as const,
  externalSquads: ['remnawave', 'external-squads'] as const,
  configProfiles: ['remnawave', 'config-profiles'] as const,
  hwidStats: ['remnawave', 'hwid-stats'] as const,
  hwidTopUsers: ['remnawave', 'hwid-top-users'] as const,
  subRequestStats: ['remnawave', 'sub-request-stats'] as const,
  subRequestHistory: ['remnawave', 'sub-request-history'] as const,
  subscriptionSettings: ['remnawave', 'subscription-settings'] as const,
  subscriptionTemplates: ['remnawave', 'subscription-templates'] as const,
  subscriptionPageConfigs: ['remnawave', 'subscription-page-configs'] as const,
  snippets: ['remnawave', 'snippets'] as const,
  infraProviders: ['remnawave', 'infra-providers'] as const,
  nodePlugins: ['remnawave', 'node-plugins'] as const,
  geo: ['remnawave', 'geo-distribution'] as const,
} as const
