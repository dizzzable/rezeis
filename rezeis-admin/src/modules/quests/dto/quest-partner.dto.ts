import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const QUEST_ID_RE = /^[a-z][a-z0-9]{19,31}$/i;
const TELEGRAM_ID_RE = /^\d{1,19}$/;
// A user reference is either a numeric telegramId or a reiwa_id CUID — the two
// shapes are disjoint (see buildUserReferenceWhere), so one field carries both.
const USER_REF_RE = /^(\d{1,19}|[a-z][a-z0-9]{19,31})$/i;

/** Signed partner postback payload. Verified end-to-end by QuestPartnerCallbackGuard. */
export class QuestPartnerCallbackDto {
  @IsString()
  @Matches(SLUG_RE)
  public partnerSlug!: string;

  @IsString()
  @Matches(QUEST_ID_RE)
  public questId!: string;

  @IsString()
  @MaxLength(128)
  public nonce!: string;

  @IsOptional()
  @IsString()
  @Matches(TELEGRAM_ID_RE)
  public telegramId?: string;

  @IsOptional()
  @IsString()
  @Matches(USER_REF_RE)
  public userRef?: string;
}

/** BFF → admin manual-code verification (identity resolved by the BFF session). */
export class InternalPartnerCodeDto {
  @IsString()
  @Matches(USER_REF_RE)
  public userRef!: string;

  @IsString()
  @Matches(QUEST_ID_RE)
  public questId!: string;

  @IsString()
  @MaxLength(128)
  public code!: string;
}

/** BFF → admin timed-visit start / completion (identity resolved by the BFF session). */
export class InternalPartnerVisitDto {
  @IsString()
  @Matches(USER_REF_RE)
  public userRef!: string;

  @IsString()
  @Matches(QUEST_ID_RE)
  public questId!: string;
}
