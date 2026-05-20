export interface RemnawaveHostInterface {
  readonly uuid: string;
  readonly viewPosition: number;
  readonly remark: string;
  readonly address: string;
  readonly port: number;
  readonly isDisabled: boolean;
  readonly isHidden: boolean;
  readonly securityLayer: string;
  readonly tag: string | null;
  readonly configProfileUuid: string | null;
  readonly configProfileInboundUuid: string | null;
  readonly nodes: readonly string[];
}
