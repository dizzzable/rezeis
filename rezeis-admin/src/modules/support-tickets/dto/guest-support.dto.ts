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
