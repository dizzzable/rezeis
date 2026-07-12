export interface AiConfigSettings {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly modelsEndpoint: string;
}

export interface AiConfigSettingsMasked {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly modelsEndpoint: string;
}
