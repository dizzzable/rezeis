export interface ApiDocsExposureOptions {
  readonly docsEnabled: boolean;
  readonly nodeEnv?: string;
}

export function shouldEnableApiDocs(options: ApiDocsExposureOptions): boolean {
  if (options.nodeEnv === 'production') {
    return false;
  }

  return options.docsEnabled === true;
}
