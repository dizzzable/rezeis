import { IsString, Length } from 'class-validator';

/**
 * Body naming the signed-in customer, for `POST /api/internal/web-auth/sessions/*`
 * and `password/state`. The cabinet takes `userId` from its own server session,
 * never from anything the browser sent.
 */
export class WebAuthUserDto {
  @IsString()
  @Length(1, 256)
  public readonly userId!: string;
}
