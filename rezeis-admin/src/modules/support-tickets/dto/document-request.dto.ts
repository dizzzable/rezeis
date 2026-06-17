import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export const DOC_REQUEST_KINDS = ['PAYMENT_PROOF', 'DOCUMENT', 'LOGIN', 'OTHER'] as const;
export type DocRequestKind = (typeof DOC_REQUEST_KINDS)[number];

/** Body for an operator's in-conversation identity/proof request. */
export class CreateDocumentRequestDto {
  @IsIn(DOC_REQUEST_KINDS)
  public readonly kind!: DocRequestKind;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  public readonly label!: string;
}
