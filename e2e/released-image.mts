/**
 * THE RELEASE OPERATORS RUN NOW — the other half of a workflow's MIXED pair.
 *
 *   node released-image.mts dizzzable/reiwa
 *
 * Prints the image on stdout (`ghcr.io/dizzzable/reiwa:v0.9.7.53`) and one
 * line on stderr saying why it was chosen, for the job summary.
 *
 * Not `:latest`. `:latest` moves the moment the other half's tag is pushed, and
 * in the release window that can be minutes before this half's own E2E runs:
 * the «mixed pair» would then test new + new and say nothing about the update
 * order it exists for (R1-02). So:
 *  - the newest `v*` image in the registry, the release operators run now;
 *  - unless that release IS the other half's `:main` — the same build, by the
 *    `org.opencontainers.image.revision` label Docker Publish stamps on both —
 *    which is the release window: then the newest `v*` older than it, the one
 *    operators still run while they update. By revision and not by version
 *    number: between releases `:main` reports the last release's number while
 *    it runs newer code, and a version match would step back a release that
 *    operators do run.
 *
 * Only anonymous registry reads, the way an operator pulls. For tests,
 * E2E_REGISTRY_FIXTURE holds `{ "tags": [...], "revisions": { "<tag>": "<sha>" } }`
 * and no request is made.
 */

interface Registry {
  tags(): Promise<string[]>;
  revision(tag: string): Promise<string | null>;
}

const MANIFEST_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');

function fixtureRegistry(raw: string): Registry {
  const fixture = JSON.parse(raw) as { tags: string[]; revisions: Record<string, string | null> };
  return {
    tags: async () => fixture.tags,
    revision: async (tag) => fixture.revisions[tag] ?? null,
  };
}

function ghcr(repository: string): Registry {
  let token: string | null = null;
  const auth = async (): Promise<Record<string, string>> => {
    if (token === null) {
      const res = await fetch(`https://ghcr.io/token?scope=repository:${repository}:pull`);
      if (!res.ok) throw new Error(`ghcr.io token for ${repository}: HTTP ${res.status}`);
      token = ((await res.json()) as { token?: string }).token ?? '';
    }
    return { Authorization: `Bearer ${token}` };
  };
  const json = async <T,>(url: string, accept?: string): Promise<{ body: T; link: string | null }> => {
    const res = await fetch(url, { headers: { ...(await auth()), ...(accept ? { Accept: accept } : {}) } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return { body: (await res.json()) as T, link: res.headers.get('link') };
  };
  return {
    async tags() {
      const all: string[] = [];
      let url: string | null = `https://ghcr.io/v2/${repository}/tags/list?n=1000`;
      for (let page = 0; url !== null && page < 50; page++) {
        const answer: { body: { tags?: string[] }; link: string | null } = await json<{ tags?: string[] }>(url);
        all.push(...(answer.body.tags ?? []));
        const next: RegExpExecArray | null = answer.link === null ? null : /<([^>]+)>;\s*rel="next"/.exec(answer.link);
        url = next === null ? null : new URL(next[1]!, 'https://ghcr.io').toString();
      }
      return all;
    },
    async revision(tag) {
      let { body: manifest } = await json<{
        config?: { digest: string };
        manifests?: Array<{ digest: string; platform?: { os?: string; architecture?: string } }>;
      }>(`https://ghcr.io/v2/${repository}/manifests/${tag}`, MANIFEST_TYPES);
      if (manifest.manifests !== undefined) {
        const amd64 = manifest.manifests.find((m) => m.platform?.os === 'linux' && m.platform.architecture === 'amd64');
        if (amd64 === undefined) return null;
        manifest = (await json<typeof manifest>(`https://ghcr.io/v2/${repository}/manifests/${amd64.digest}`, MANIFEST_TYPES)).body;
      }
      if (manifest.config === undefined) return null;
      const { body: config } = await json<{ config?: { Labels?: Record<string, string> } }>(
        `https://ghcr.io/v2/${repository}/blobs/${manifest.config.digest}`,
      );
      return config.config?.Labels?.['org.opencontainers.image.revision'] ?? null;
    },
  };
}

function compareVersions(a: string, b: string): number {
  const left = a.replace(/^v/, '').split('.').map(Number);
  const right = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function main(): Promise<void> {
  const repository = process.argv[2] ?? '';
  if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(repository)) {
    throw new Error(`usage: node released-image.mts <owner/repo, lower case> (got "${repository}")`);
  }
  const registry = process.env.E2E_REGISTRY_FIXTURE ? fixtureRegistry(process.env.E2E_REGISTRY_FIXTURE) : ghcr(repository);
  const releases = (await registry.tags()).filter((tag) => /^v\d+(\.\d+)+$/.test(tag)).sort(compareVersions);
  const newest = releases.at(-1);
  if (newest === undefined) throw new Error(`${repository} has no v* image in the registry`);
  const [mainRevision, newestRevision] = await Promise.all([registry.revision('main'), registry.revision(newest)]);
  let chosen = newest;
  let why = `${newest} is the newest release, the one operators run now (not :latest, which moves)`;
  if (mainRevision !== null && mainRevision === newestRevision) {
    const previous = releases.at(-2);
    if (previous === undefined) {
      why = `${newest} is the newest release and also :main (${mainRevision.slice(0, 7)}), with no older release to step back to`;
    } else {
      chosen = previous;
      why =
        `${newest} is the same build as :main (${mainRevision.slice(0, 7)}), so the mixed pair steps back to ` +
        `${previous}, the release operators run until they update`;
    }
  } else if (mainRevision === null || newestRevision === null) {
    why += `; revision unknown for ${mainRevision === null ? ':main' : newest}, so it was not compared with :main`;
  }
  process.stdout.write(`ghcr.io/${repository}:${chosen}\n`);
  process.stderr.write(`mixed pair, ${repository}: ${why}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`released-image: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
