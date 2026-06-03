import type { NestExpressApplication } from '@nestjs/platform-express';

export const HTTP_BODY_PARSER_LIMIT = '10mb';

export function configureBoundedBodyParsers(app: Pick<NestExpressApplication, 'useBodyParser'>): void {
  app.useBodyParser('json', { limit: HTTP_BODY_PARSER_LIMIT });
  app.useBodyParser('urlencoded', { extended: true, limit: HTTP_BODY_PARSER_LIMIT });
}
