import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Body for opening an anonymous (guest) support conversation. */
export class CreateGuestTicketDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  public readonly subject!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  public readonly message!: string;

  /** Optional contact for reply continuity if the visitor closes the tab. */
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  public readonly email?: string;

  /**
   * Browser device signals, sent by the cabinet at the moment the conversation
   * is opened.
   *
   * Both optional and both useless to lie about in the direction that would
   * help: omitting them, or sending junk, produces an unmarked conversation —
   * which is what an unrecognised visitor gets anyway. What they cannot do is
   * make somebody ELSE look like the pest, because the values are only ever
   * compared against the blocklist and never written to another account.
   *
   * Length bounds match `normaliseDeviceSignal`, which is what actually
   * validates them; these keep an oversized body from reaching it at all.
   */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  public readonly installId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  public readonly deviceHash?: string;
}

/** Body for appending a guest reply to an open conversation. */
export class GuestReplyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  public readonly content!: string;
}

/** Body for attaching a guest conversation to a logged-in account. */
export class AttachGuestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public readonly userRef!: string;
}
