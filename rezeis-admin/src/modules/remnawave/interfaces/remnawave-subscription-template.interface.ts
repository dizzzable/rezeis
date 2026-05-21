export interface RemnawaveSubscriptionTemplateInterface {
  readonly uuid: string;
  readonly name: string;
  readonly viewPosition: number;
  readonly templateType: string;
  readonly templateJson: unknown | null;
  readonly encodedTemplateYaml: string | null;
}
