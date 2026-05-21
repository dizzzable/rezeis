import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

/**
 * Query DTO for `GET /admin/users`.
 *
 * Powers the left-hand list on the admin Users page. Supports:
 *   • `search` — free-text fragment matched against `id`, `telegramId`,
 *     `username`, `email`, `name`, `referralCode`, and the linked
 *     `WebAccount.login` (case-insensitive `contains`).
 *   • `limit` / `offset` — bounded paging.
 */
export class AdminUserListQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 128)
  public search?: string;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public limit?: number;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  public offset?: number;
}
