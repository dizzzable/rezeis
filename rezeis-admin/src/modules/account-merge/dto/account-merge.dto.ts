import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';

/** Query for `GET /api/admin/users/:id/merge-preview`. */
export class AccountMergePreviewQueryDto {
  /** login / telegramId / reiwa_id / email of the counterpart account. */
  @IsString()
  @Length(1, 254)
  public readonly ref!: string;
}

export class MergeChoicesDto {
  @IsOptional()
  @IsIn(['source', 'target'])
  public readonly keepLogin?: 'source' | 'target';

  @IsOptional()
  @IsIn(['source', 'target'])
  public readonly keepTelegram?: 'source' | 'target';

  @IsOptional()
  @IsIn(['source', 'target'])
  public readonly keepEmail?: 'source' | 'target';

  @IsOptional()
  @IsString()
  @Length(1, 64)
  public readonly currentSubscriptionId?: string;
}

/** Body for `POST /api/admin/users/merge`. */
export class AccountMergeDto {
  @IsString()
  @Length(1, 64)
  public readonly sourceId!: string;

  @IsString()
  @Length(1, 64)
  public readonly targetId!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MergeChoicesDto)
  public readonly choices?: MergeChoicesDto;

  /** Irreversible-operation acknowledgement; must be `true`. */
  @IsBoolean()
  public readonly confirm!: boolean;
}
