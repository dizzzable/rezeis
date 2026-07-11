export interface ApiDocsExposureOptions {
  readonly docsEnabled: boolean;
  readonly nodeEnv?: string;
}

export function shouldEnableApiDocs(options: ApiDocsExposureOptions): boolean {
  // API documentation is an explicit operator opt-in. `API_DOCS_ENABLED=true`
  // must therefore work in every environment, including production; false or
  // an absent value remains fail-closed via the validated config parser.
  return options.docsEnabled === true;
}
