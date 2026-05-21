import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExecutionContext, NotFoundException, RequestMethod, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA, HEADERS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Request, Response } from 'express';

import { metricsConfig } from '../src/common/config/metrics.config';
import { httpMetricsRegistry } from '../src/common/metrics/http-metrics.registry';
import { createRequestCorrelationMiddleware } from '../src/common/middleware/request-correlation.middleware';
import { MetricsAccessGuard } from '../src/modules/metrics/metrics-access.guard';
import { MetricsController } from '../src/modules/metrics/metrics.controller';
import { MetricsService } from '../src/modules/metrics/metrics.service';

interface CapturedResponse {
  readonly headers: Record<string, string>;
  readonly finishHandlers: Array<() => void>;
  statusCode: number;
}

function createExecutionContext(
  authorization: string | undefined,
): ExecutionContext & { readonly response: Response & CapturedResponse } {
  const response = createResponse(200);
  const request = {
    headers: authorization ? { authorization } : {},
  } as unknown as Request;

  const context = {
    response,
    switchToHttp() {
      return {
        getRequest: () => request,
        getResponse: () => response,
      };
    },
  } as unknown as ExecutionContext & { readonly response: Response & CapturedResponse };

  return context;
}

function buildBasicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function createResponse(statusCode: number): Response & CapturedResponse {
  const response: CapturedResponse & {
    setHeader(name: string, value: string): void;
    once(eventName: string, handler: () => void): void;
  } = {
    headers: {},
    finishHandlers: [],
    statusCode,
    setHeader(name: string, value: string): void {
      this.headers[name.toLowerCase()] = value;
    },
    once(eventName: string, handler: () => void): void {
      if (eventName === 'finish') {
        this.finishHandlers.push(handler);
      }
    },
  };
  return response as unknown as Response & CapturedResponse;
}

function runMiddlewareRequest(method: string, rawUrl: string, statusCode: number): void {
  const middleware = createRequestCorrelationMiddleware({ log: () => undefined });
  const request = {
    headers: {},
    method,
    originalUrl: rawUrl,
  } as unknown as Request;
  const response = createResponse(statusCode);

  middleware(request, response, () => undefined);
  response.finishHandlers.forEach((handler) => handler());
}

describe('metrics foundation', () => {
  it('renders Prometheus runtime metrics and low-cardinality HTTP metrics', () => {
    httpMetricsRegistry.reset();
    runMiddlewareRequest('GET', '/api/users/raw-user@example.com?token=raw-query-secret', 200);
    runMiddlewareRequest('POST', '/api/payments/550e8400-e29b-41d4-a716-446655440000', 503);

    const metrics = new MetricsService().renderPrometheusText();

    assert.match(metrics, /# TYPE rezeis_admin_process_resident_memory_bytes gauge/);
    assert.match(metrics, /# TYPE rezeis_admin_process_uptime_seconds gauge/);
    assert.match(metrics, /# TYPE rezeis_admin_http_requests_total counter/);
    assert.match(metrics, /rezeis_admin_http_requests_total\{method="GET",statusClass="2xx"\} 1/);
    assert.match(metrics, /rezeis_admin_http_requests_total\{method="POST",statusClass="5xx"\} 1/);
    assert.match(metrics, /rezeis_admin_http_request_duration_seconds_bucket\{le="\+Inf",method="GET",statusClass="2xx"\} 1/);
    assert.doesNotMatch(metrics, /raw-user@example\.com/);
    assert.doesNotMatch(metrics, /raw-query-secret/);
    assert.doesNotMatch(metrics, /550e8400-e29b-41d4-a716-446655440000/);
    assert.doesNotMatch(metrics, /path=/);
    assert.doesNotMatch(metrics, /authorization/i);
    assert.doesNotMatch(metrics, /cookie/i);
  });

  it('normalizes unsafe metric label values instead of exposing raw method/status data', () => {
    httpMetricsRegistry.reset();
    httpMetricsRegistry.record({ method: 'GET /token-secret', statusCode: 999, durationMs: -10 });
    httpMetricsRegistry.record({ method: 'FOOBAR', statusCode: 204, durationMs: 1 });

    const metrics = httpMetricsRegistry.render();

    assert.match(metrics, /rezeis_admin_http_requests_total\{method="UNKNOWN",statusClass="unknown"\} 1/);
    assert.match(metrics, /rezeis_admin_http_requests_total\{method="UNKNOWN",statusClass="2xx"\} 1/);
    assert.doesNotMatch(metrics, /token-secret/);
    assert.doesNotMatch(metrics, /FOOBAR/);
    assert.doesNotMatch(metrics, /999/);
  });

  it('exposes metrics through the controller without changing metric contents', () => {
    httpMetricsRegistry.reset();
    httpMetricsRegistry.record({ method: 'DELETE', statusCode: 404, durationMs: 25 });

    const controller = new MetricsController(new MetricsService());
    const metrics = controller.getMetrics();

    assert.match(metrics, /rezeis_admin_http_requests_total\{method="DELETE",statusClass="4xx"\} 1/);
    assert.match(metrics, /rezeis_admin_http_request_duration_seconds_sum\{method="DELETE",statusClass="4xx"\} 0\.025/);
  });

  it('keeps the metrics controller route and content type explicit', () => {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, MetricsController);
    const methodPath = Reflect.getMetadata(PATH_METADATA, MetricsController.prototype.getMetrics);
    const requestMethod = Reflect.getMetadata(METHOD_METADATA, MetricsController.prototype.getMetrics);
    const headers = Reflect.getMetadata(HEADERS_METADATA, MetricsController.prototype.getMetrics) as
      | Array<{ name: string; value: string }>
      | undefined;

    assert.equal(controllerPath, 'metrics');
    assert.equal(methodPath, '/');
    assert.equal(requestMethod, RequestMethod.GET);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, MetricsController.prototype.getMetrics), [
      MetricsAccessGuard,
    ]);
    assert.deepEqual(headers, [
      {
        name: 'Content-Type',
        value: 'text/plain; version=0.0.4; charset=utf-8',
      },
    ]);
  });

  it('allows open metrics mode without requiring authorization', () => {
    const guard = new MetricsAccessGuard({ accessMode: 'open' } as ReturnType<typeof metricsConfig>);

    assert.equal(guard.canActivate(createExecutionContext(undefined)), true);
  });

  it('hides disabled metrics endpoint behind a not found response', () => {
    const guard = new MetricsAccessGuard({ accessMode: 'disabled' } as ReturnType<typeof metricsConfig>);

    assert.throws(() => guard.canActivate(createExecutionContext(undefined)), NotFoundException);
  });

  it('requires bounded basic auth without exposing supplied credentials', () => {
    const guard = new MetricsAccessGuard({
      accessMode: 'basic',
      basicAuthUsername: 'prometheus',
      basicAuthPassword: 'safe-password',
    } as ReturnType<typeof metricsConfig>);
    const missingAuthorizationContext = createExecutionContext(undefined);
    const rawSecretAuthorization = buildBasicAuthorization('prometheus', 'raw-provider-token-secret');
    const wrongAuthorizationContext = createExecutionContext(rawSecretAuthorization);
    const correctAuthorizationContext = createExecutionContext(buildBasicAuthorization('prometheus', 'safe-password'));

    assert.throws(() => guard.canActivate(missingAuthorizationContext), UnauthorizedException);
    assert.equal(
      missingAuthorizationContext.response.headers['www-authenticate'],
      'Basic realm="Rezeis Admin Metrics"',
    );

    try {
      guard.canActivate(wrongAuthorizationContext);
      assert.fail('expected metrics guard to reject invalid credentials');
    } catch (error) {
      assert.ok(error instanceof UnauthorizedException);
      assert.doesNotMatch(JSON.stringify(error.getResponse()), /raw-provider-token-secret/);
      assert.doesNotMatch(JSON.stringify(error.getResponse()), /prometheus/);
    }

    assert.equal(guard.canActivate(correctAuthorizationContext), true);
  });
});
