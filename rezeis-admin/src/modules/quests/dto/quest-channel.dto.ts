import {
  IsBoolean,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const TELEGRAM_ID_RE = /^\d{1,19}$/;
const QUEST_ID_RE = /^[a-z][a-z0-9]{19,31}$/i;

export class QuestChannelTargetDto {
  @IsString()
  @Matches(TELEGRAM_ID_RE)
  public telegramId!: string;

  @IsString()
  @MaxLength(32)
  @Matches(QUEST_ID_RE)
  public questId!: string;
}

export class QuestChannelRecheckDto extends QuestChannelTargetDto {
  @IsBoolean()
  public isMember!: boolean;
}
