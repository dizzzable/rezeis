import { IsString, Length } from 'class-validator';

/** Body payload for `PATCH /admin/users/:telegramId/web/login`. */
export class RenameWebLoginDto {
  @IsString()
  @Length(3, 64)
  public login!: string;
}
