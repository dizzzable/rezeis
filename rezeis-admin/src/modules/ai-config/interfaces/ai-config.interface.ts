export interface AiConfigSettings {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly modelsEndpoint: string;
  /** Master switch for the user-facing assistant (cabinet tab + bot). */
  readonly enabled: boolean;
  /** Operator-authored persona / extra instructions appended below the
   *  non-negotiable security preamble. */
  readonly systemPrompt: string;
}

export interface AiConfigSettingsMasked {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly modelsEndpoint: string;
  readonly enabled: boolean;
  readonly systemPrompt: string;
}
