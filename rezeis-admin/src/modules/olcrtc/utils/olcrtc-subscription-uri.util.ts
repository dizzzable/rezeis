const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  TELEMOST: 'telemost',
  WBSTREAM: 'wbstream',
  JITSI: 'jitsi',
};

const TRANSPORT_NAMES: Readonly<Record<string, string>> = {
  VP8CHANNEL: 'vp8channel',
  DATACHANNEL: 'datachannel',
  SEICHANNEL: 'seichannel',
  VIDEOCHANNEL: 'videochannel',
};

const TRANSPORT_OPTION_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  VP8CHANNEL: { fps: 'vp8-fps', batchSize: 'vp8-batch' },
  SEICHANNEL: { fps: 'fps', batchSize: 'batch', fragmentSize: 'frag', ackTimeoutMs: 'ack-ms' },
  VIDEOCHANNEL: {
    width: 'video-w',
    height: 'video-h',
    fps: 'video-fps',
    bitrate: 'video-bitrate',
    hw: 'video-hw',
    codec: 'video-codec',
    qrSize: 'video-qr-size',
    qrRecovery: 'video-qr-recovery',
    tileModule: 'video-tile-module',
    tileRs: 'video-tile-rs',
  },
};

export interface OlcrtcSubscriptionUriInput {
  readonly provider: string;
  readonly transport: string;
  readonly roomId: string;
  readonly cryptoKey: string;
  readonly name: string;
  readonly transportOptions?: Record<string, unknown> | null;
}

export function buildOlcrtcSubscriptionUri(input: OlcrtcSubscriptionUriInput): string {
  const provider = PROVIDER_NAMES[input.provider] ?? input.provider.toLowerCase();
  const transport = TRANSPORT_NAMES[input.transport] ?? input.transport.toLowerCase();
  const options = buildTransportOptions(input.transport, input.transportOptions ?? {});
  return `olcrtc://${provider}?${transport}${options}@${input.roomId}#${input.cryptoKey}$${input.name}`;
}

function buildTransportOptions(
  transport: string,
  options: Record<string, unknown>,
): string {
  const keyMap = TRANSPORT_OPTION_KEYS[transport];
  if (!keyMap) return '';

  const params = Object.entries(keyMap)
    .flatMap(([source, target]) => {
      const value = options[source];
      if (value === undefined || value === null || value === '') return [];
      return [`${target}=${encodeURIComponent(String(value))}`];
    })
    .join('&');

  return params.length > 0 ? `<${params}>` : '';
}

export function buildOlcrtcSubscriptionText(
  uri: string,
  name: string,
  refreshSeconds: number,
): string {
  return [`#name: ${name}`, '#update: 2147483647', `#refresh: ${refreshSeconds}`, uri].join('\n');
}
