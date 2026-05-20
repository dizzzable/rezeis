import {
  applyDecorators,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Put,
  Type,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiInternalServerErrorResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

export interface EndpointOptions {
  /** HTTP method string: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' */
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Controller route path segment (e.g. '', ':id', 'block') */
  path?: string;
  /** Expected success HTTP status code */
  httpCode?: number;
  /** Swagger summary */
  summary: string;
  /** Swagger description (optional) */
  description?: string;
  /** DTO class for @ApiBody (optional) */
  bodyType?: Type<unknown>;
}

/**
 * Composite decorator that wires HTTP method, status code, and standard
 * Swagger annotations in a single call — keeps controllers DRY.
 *
 * @example
 * @Endpoint({ method: 'POST', path: ':id/block', httpCode: 200, summary: 'Block user' })
 * async blockUser(@Param('id') id: string) { ... }
 */
export function Endpoint(options: EndpointOptions) {
  const { method, path = '', httpCode = 200, summary, description, bodyType } = options;

  const methodDecorator = resolveMethod(method)(path);
  const codeDecorator = HttpCode(httpCode);

  const swaggerDecorators = [
    ApiOperation({ summary, description }),
    ApiInternalServerErrorResponse({
      description: 'Internal server error',
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          errorCode: { type: 'string', example: 'R000' },
          statusCode: { type: 'number', example: 500 },
          timestamp: { type: 'string' },
          path: { type: 'string' },
        },
      },
    }),
    ApiBadRequestResponse({
      description: 'Validation error',
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          errorCode: { type: 'string', example: 'R003' },
          statusCode: { type: 'number', example: 400 },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
    }),
    ApiUnauthorizedResponse({
      description: 'Unauthorized',
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          errorCode: { type: 'string', example: 'R001' },
          statusCode: { type: 'number', example: 401 },
        },
      },
    }),
    ...(bodyType ? [ApiBody({ type: bodyType })] : []),
  ];

  return applyDecorators(methodDecorator, codeDecorator, ...swaggerDecorators);
}

function resolveMethod(method: string) {
  switch (method.toUpperCase()) {
    case 'GET':    return Get;
    case 'POST':   return Post;
    case 'PATCH':  return Patch;
    case 'PUT':    return Put;
    case 'DELETE': return Delete;
    default:       return Get;
  }
}
