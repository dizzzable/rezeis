import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PaymentGatewayType } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  ANTILOPAY_INVALID_SIGNATURE,
  ANTILOPAY_IP_NOT_ALLOWED,
  ANTILOPAY_SECRET_ID_MISSING,
  ANTILOPAY_SECRET_ID_UNKNOWN,
  postAntilopaySignatureCheck,
} from '../utils/antilopay-api.util';
import { signsLikeCheckout } from '../utils/antilopay-keys.util';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import { redactPaymentDiagnosticMessage } from '../utils/payment-provider-error.util';
import { readOptionalString } from './payment-provider-execution.helpers';

/**
 * What «Проверить ключи» found out. One word per outcome the settings page
 * words in Russian and English; the numbers ride along so an answer nobody
 * expected is still reported as what Antilopay said.
 *   - OK: Antilopay accepted the signature (`{"status":"ok"}`);
 *   - SIGNATURE_REFUSED: error 3, the signature does not match the Secret ID's
 *     key, so the Secret ID or the private key is wrong;
 *   - SECRET_ID_REJECTED: error 1 or 2, the Secret ID is missing or unknown;
 *   - IP_NOT_ALLOWED: error 22, the project restricts API access by address and
 *     this server's outgoing address is not on the list;
 *   - KEYS_MISSING / PRIVATE_KEY_UNREADABLE: nothing was asked, the stored
 *     Secret ID or private key is not there, or does not sign;
 *   - NOT_ANSWERED: no usable answer (a timeout, a connection failure, a page
 *     that is not JSON) or a code this button does not know.
 */
export type AntilopayKeyCheckVerdict =
  | 'OK'
  | 'SIGNATURE_REFUSED'
  | 'SECRET_ID_REJECTED'
  | 'IP_NOT_ALLOWED'
  | 'KEYS_MISSING'
  | 'PRIVATE_KEY_UNREADABLE'
  | 'NOT_ANSWERED';

export interface AntilopayKeyCheckResult {
  readonly verdict: AntilopayKeyCheckVerdict;
  /** Antilopay's own `code`, when its answer carried one. */
  readonly code: number | null;
  /** The HTTP status of an answer that was not a verdict, for the operator's report. */
  readonly httpStatus: number | null;
  /** How a call that got no answer ended. */
  readonly failure: 'TIMEOUT' | 'NETWORK' | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Antilopay's answer to `signature/check` (documentation 4.1) as a verdict.
 * `{"status":"ok"}` is the success; a refusal is `{"code":3,"error":"Invalid
 * signature"}`, and the code is what is read, never the text.
 */
export function readAntilopaySignatureCheckReply(httpStatus: number | null, data: unknown): AntilopayKeyCheckResult {
  const record = isRecord(data) ? data : null;
  const status = record === null ? null : record['status'];
  const code = record !== null && typeof record['code'] === 'number' ? record['code'] : null;
  if ((typeof status === 'string' && status.trim().toLowerCase() === 'ok') || code === 0) {
    return { verdict: 'OK', code: null, httpStatus, failure: null };
  }
  const verdictOf = (verdict: AntilopayKeyCheckVerdict): AntilopayKeyCheckResult => ({
    verdict,
    code,
    httpStatus,
    failure: null,
  });
  if (code === ANTILOPAY_INVALID_SIGNATURE) return verdictOf('SIGNATURE_REFUSED');
  if (code === ANTILOPAY_SECRET_ID_MISSING || code === ANTILOPAY_SECRET_ID_UNKNOWN) {
    return verdictOf('SECRET_ID_REJECTED');
  }
  if (code === ANTILOPAY_IP_NOT_ALLOWED) return verdictOf('IP_NOT_ALLOWED');
  return verdictOf('NOT_ANSWERED');
}

/** A call that got no answer: a timeout is told apart from every other failure to connect. */
function readCallFailure(error: unknown): 'TIMEOUT' | 'NETWORK' {
  const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : '';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT' || message.includes('timeout') ? 'TIMEOUT' : 'NETWORK';
}

/**
 * «Проверить ключи» on the Antilopay settings card: signs a small JSON with the
 * credentials that are STORED (not the ones in the form, which may not be saved
 * yet) and has Antilopay's own `signature/check` say whether the signature is
 * accepted. It tells the operator, before the first customer, that the Secret
 * ID and the private key work together and that this server may call the API.
 *
 * The public key is not tested, and cannot be by this call: it only verifies
 * Antilopay's callbacks to us, which nothing here can provoke.
 */
@Injectable()
export class AntilopayKeyCheckService {
  private readonly logger = new Logger(AntilopayKeyCheckService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly httpService: HttpService,
  ) {}

  public async check(gatewayId: string): Promise<AntilopayKeyCheckResult> {
    const gateway = await this.prismaService.paymentGateway.findUnique({ where: { id: gatewayId } });
    if (gateway === null) {
      throw new NotFoundException('Payment gateway not found');
    }
    if (gateway.type !== PaymentGatewayType.ANTILOPAY) {
      throw new BadRequestException('PAYMENT_GATEWAY_KEY_CHECK_UNSUPPORTED');
    }
    const settings = readGatewaySettings(gateway.settings);
    const privateKey = readOptionalString(settings, ['privateKey']);
    if (readOptionalString(settings, ['secretId']) === null || privateKey === null) {
      return { verdict: 'KEYS_MISSING', code: null, httpStatus: null, failure: null };
    }
    if (!signsLikeCheckout(privateKey)) {
      return { verdict: 'PRIVATE_KEY_UNREADABLE', code: null, httpStatus: null, failure: null };
    }
    try {
      const reply = await postAntilopaySignatureCheck(this.httpService, settings);
      return readAntilopaySignatureCheckReply(reply.httpStatus, reply.data);
    } catch (error) {
      const failure = readCallFailure(error);
      this.logger.warn(
        `Antilopay signature check got no answer (${failure}): ${
          redactPaymentDiagnosticMessage(error instanceof Error ? error.message : String(error), 160) ?? 'unknown'
        }`,
      );
      return { verdict: 'NOT_ANSWERED', code: null, httpStatus: null, failure };
    }
  }
}
