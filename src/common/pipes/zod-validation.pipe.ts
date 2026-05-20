import { PipeTransform, Injectable, BadRequestException, ArgumentMetadata } from '@nestjs/common';
import { z } from 'zod';

/**
 * Zod validation pipe (inspired by remnawave backend-main).
 * Use as parameter pipe: @Body(new ZodPipe(schema)) or globally.
 *
 * Usage:
 *   const CreateUserSchema = z.object({ username: z.string().min(3) });
 *   type CreateUserDto = z.infer<typeof CreateUserSchema>;
 *
 *   @Post()
 *   create(@Body(new ZodPipe(CreateUserSchema)) dto: CreateUserDto) { ... }
 */
@Injectable()
export class ZodPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Validation failed',
        errorCode: 'VALIDATION_ERROR',
        errors: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }
    return result.data;
  }
}
