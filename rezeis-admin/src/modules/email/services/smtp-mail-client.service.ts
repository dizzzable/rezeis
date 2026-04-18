import { randomBytes } from 'node:crypto';
import { Socket, connect as connectSocket } from 'node:net';
import { TLSSocket, connect as connectTls } from 'node:tls';

import {
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { emailConfig } from '../../../common/config/email.config';
import { EmailDeliveryException } from '../errors/email-delivery.exception';

interface SmtpMailMessage {
  readonly to: string;
  readonly from: string;
  readonly replyTo: string | null;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

interface SmtpResponse {
  readonly code: number;
  readonly lines: readonly string[];
}

interface SmtpConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
}

const SMTP_READY_CODE = 220;
const SMTP_AUTH_SUCCESS_CODE = 235;
const SMTP_OK_CODE = 250;
const SMTP_AUTH_CHALLENGE_CODE = 334;
const SMTP_DATA_READY_CODE = 354;
const SMTP_NEWLINE = '\r\n';
const SMTP_CLOSE_TIMEOUT_MS = 1000;
const SMTP_QUIT_CODE = 221;

/**
 * Sends transactional emails over a direct SMTP connection.
 */
@Injectable()
export class SmtpMailClientService {
  public constructor(
    @Inject(emailConfig.KEY)
    private readonly configuration: ConfigType<typeof emailConfig>,
  ) {}

  /**
   * Delivers a single email message through the configured SMTP relay.
   */
  public async sendMail(input: SmtpMailMessage): Promise<void> {
    let session: SmtpSession | null = null;
    const identityDomain = resolveSmtpIdentityDomain({
      explicitIdentityDomain: this.configuration.identityDomain,
      fromAddress: this.configuration.fromAddress,
    });
    try {
      session = await SmtpSession.connect({
        host: this.configuration.host,
        port: this.configuration.port,
        secure: this.configuration.secure,
        timeoutMs: this.configuration.timeoutMs,
      });
      const greeting = await session.readResponse();
      assertResponseCode(greeting, [SMTP_READY_CODE]);
      let ehloResponse = await session.sendCommand(`EHLO ${identityDomain}`);
      assertResponseCode(ehloResponse, [SMTP_OK_CODE]);
      if (!this.configuration.secure && supportsExtension(ehloResponse, 'STARTTLS')) {
        const startTlsResponse = await session.sendCommand('STARTTLS');
        assertResponseCode(startTlsResponse, [SMTP_READY_CODE]);
        session = await session.upgradeToTls({
          host: this.configuration.host,
          timeoutMs: this.configuration.timeoutMs,
        });
        ehloResponse = await session.sendCommand(`EHLO ${identityDomain}`);
        assertResponseCode(ehloResponse, [SMTP_OK_CODE]);
      }
      await authenticateSession({
        session,
        response: ehloResponse,
        user: this.configuration.user,
        password: this.configuration.password,
      });
      const mailFromResponse = await session.sendCommand(
        `MAIL FROM:<${this.configuration.fromAddress}>`,
      );
      assertResponseCode(mailFromResponse, [SMTP_OK_CODE]);
      const recipientResponse = await session.sendCommand(`RCPT TO:<${input.to}>`);
      assertResponseCode(recipientResponse, [SMTP_OK_CODE]);
      const dataResponse = await session.sendCommand('DATA');
      assertResponseCode(dataResponse, [SMTP_DATA_READY_CODE]);
      try {
        await session.writeMessage(
          createMimeMessage({
            message: input,
            identityDomain,
          }),
        );
      } catch {
        throw new EmailDeliveryException('delivery-status-uncertain');
      }
      let queuedResponse: SmtpResponse;
      try {
        queuedResponse = await session.readResponse();
      } catch {
        throw new EmailDeliveryException('delivery-status-uncertain');
      }
      assertResponseCode(queuedResponse, [SMTP_OK_CODE]);
      await closeSessionGracefully(session);
      await session.close();
    } catch (error: unknown) {
      if (session !== null) {
        await session.close();
      }
      if (error instanceof EmailDeliveryException) {
        throw error;
      }
      throw new EmailDeliveryException('definitely-not-delivered');
    }
  }
}

class SmtpSession {
  private readonly pendingLines: string[] = [];
  private readonly pendingReads: Array<{
    readonly resolve: (line: string) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  private buffer: string = '';
  private endedError: Error | null = null;
  private readonly handleDataBound = (chunk: Buffer | string): void => {
    this.handleData(chunk);
  };
  private readonly handleErrorBound = (error: Error): void => {
    this.handleError(error);
  };
  private readonly handleEndBound = (): void => {
    this.handleError(new Error('SMTP connection closed unexpectedly'));
  };
  private readonly handleTimeoutBound = (): void => {
    this.handleError(new Error('SMTP connection timed out'));
    this.socket.destroy();
  };

  private constructor(
    private readonly socket: Socket | TLSSocket,
    private readonly timeoutMs: number,
  ) {
    this.socket.setEncoding('utf8');
    this.socket.on('data', this.handleDataBound);
    this.socket.on('error', this.handleErrorBound);
    this.socket.on('end', this.handleEndBound);
    this.socket.on('timeout', this.handleTimeoutBound);
  }

  public static async connect(input: {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly timeoutMs: number;
  }): Promise<SmtpSession> {
    const socket = input.secure
      ? await connectSecureSocket(input)
      : await connectPlainSocket(input);
    socket.setTimeout(input.timeoutMs);
    return new SmtpSession(socket, input.timeoutMs);
  }

  public async readResponse(): Promise<SmtpResponse> {
    const lines: string[] = [];
    let line = await this.readLine();
    lines.push(line);
    while (line[3] === '-') {
      line = await this.readLine();
      lines.push(line);
    }
    const code = Number.parseInt(lines[0].slice(0, 3), 10);
    if (Number.isNaN(code)) {
      throw new Error(`Invalid SMTP response: ${lines.join(' | ')}`);
    }
    return {
      code,
      lines,
    };
  }

  public async sendCommand(command: string): Promise<SmtpResponse> {
    await this.write(`${command}${SMTP_NEWLINE}`);
    return this.readResponse();
  }

  public async writeMessage(message: string): Promise<void> {
    const encodedMessage = message
      .replace(/\r?\n/g, SMTP_NEWLINE)
      .replace(/(^|\r\n)\./g, '$1..');
    await this.write(`${encodedMessage}${SMTP_NEWLINE}.${SMTP_NEWLINE}`);
  }

  public async upgradeToTls(input: {
    readonly host: string;
    readonly timeoutMs: number;
  }): Promise<SmtpSession> {
    this.removeListeners();
    const upgradedSocket = await new Promise<TLSSocket>((resolve, reject): void => {
      let isSettled = false;
      const tlsSocket = connectTls({
        socket: this.socket,
        servername: input.host,
      });
      const timeoutHandle = setTimeout((): void => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        tlsSocket.destroy(new Error('SMTP connection timed out'));
        reject(new Error('SMTP connection timed out'));
      }, input.timeoutMs);
      tlsSocket.once('secureConnect', (): void => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        clearTimeout(timeoutHandle);
        resolve(tlsSocket);
      });
      tlsSocket.once('error', (error: Error): void => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        clearTimeout(timeoutHandle);
        reject(error);
      });
      tlsSocket.setTimeout(input.timeoutMs);
    });
    return new SmtpSession(upgradedSocket, input.timeoutMs);
  }

  public async close(): Promise<void> {
    this.removeListeners();
    if (this.socket.destroyed) {
      return;
    }
    await new Promise<void>((resolve): void => {
      let isSettled = false;
      const timeoutHandle = setTimeout((): void => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        this.socket.destroy();
        resolve();
      }, Math.min(this.timeoutMs, SMTP_CLOSE_TIMEOUT_MS));
      this.socket.once('close', (): void => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        clearTimeout(timeoutHandle);
        resolve();
      });
      this.socket.end();
    });
  }

  private handleData(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    let separatorIndex = this.buffer.indexOf(SMTP_NEWLINE);
    while (separatorIndex >= 0) {
      const line = this.buffer.slice(0, separatorIndex);
      this.buffer = this.buffer.slice(separatorIndex + SMTP_NEWLINE.length);
      this.pushLine(line);
      separatorIndex = this.buffer.indexOf(SMTP_NEWLINE);
    }
  }

  private handleError(error: Error): void {
    if (this.endedError !== null) {
      return;
    }
    this.endedError = error;
    while (this.pendingReads.length > 0) {
      const pendingRead = this.pendingReads.shift();
      pendingRead?.reject(error);
    }
  }

  private pushLine(line: string): void {
    const pendingRead = this.pendingReads.shift();
    if (pendingRead) {
      pendingRead.resolve(line);
      return;
    }
    this.pendingLines.push(line);
  }

  private async readLine(): Promise<string> {
    if (this.pendingLines.length > 0) {
      return this.pendingLines.shift() ?? '';
    }
    if (this.endedError !== null) {
      throw this.endedError;
    }
    return new Promise<string>((resolve, reject): void => {
      this.pendingReads.push({ resolve, reject });
    });
  }

  private async write(value: string): Promise<void> {
    await new Promise<void>((resolve, reject): void => {
      this.socket.write(value, (error?: Error | null): void => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private removeListeners(): void {
    this.socket.off('data', this.handleDataBound);
    this.socket.off('error', this.handleErrorBound);
    this.socket.off('end', this.handleEndBound);
    this.socket.off('timeout', this.handleTimeoutBound);
  }
}

async function connectPlainSocket(input: SmtpConnectionOptions): Promise<Socket> {
  return new Promise<Socket>((resolve, reject): void => {
    let isSettled = false;
    const timeoutHandle = setTimeout((): void => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      socket.destroy(new Error('SMTP connection timed out'));
      reject(new Error('SMTP connection timed out'));
    }, input.timeoutMs);
    const socket = connectSocket(input.port, input.host);
    socket.once('connect', (): void => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      clearTimeout(timeoutHandle);
      resolve(socket);
    });
    socket.once('error', (error: Error): void => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    });
  });
}

async function connectSecureSocket(input: SmtpConnectionOptions): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject): void => {
    let isSettled = false;
    const timeoutHandle = setTimeout((): void => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      socket.destroy(new Error('SMTP connection timed out'));
      reject(new Error('SMTP connection timed out'));
    }, input.timeoutMs);
    const socket = connectTls(
      {
        host: input.host,
        port: input.port,
        servername: input.host,
      },
      (): void => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        clearTimeout(timeoutHandle);
        resolve(socket);
      },
    );
    socket.once('error', (error: Error): void => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    });
  });
}

async function authenticateSession(input: {
  readonly session: SmtpSession;
  readonly response: SmtpResponse;
  readonly user: string | null;
  readonly password: string | null;
}): Promise<void> {
  if (input.user === null || input.password === null) {
    return;
  }
  const authenticationMethods = getAuthenticationMethods(input.response);
  if (authenticationMethods.includes('PLAIN')) {
    const encodedCredentials = Buffer.from(`\0${input.user}\0${input.password}`).toString('base64');
    const response = await input.session.sendCommand(`AUTH PLAIN ${encodedCredentials}`);
    assertResponseCode(response, [SMTP_AUTH_SUCCESS_CODE]);
    return;
  }
  if (authenticationMethods.includes('LOGIN')) {
    const loginResponse = await input.session.sendCommand('AUTH LOGIN');
    assertResponseCode(loginResponse, [SMTP_AUTH_CHALLENGE_CODE]);
    const usernameResponse = await input.session.sendCommand(
      Buffer.from(input.user).toString('base64'),
    );
    assertResponseCode(usernameResponse, [SMTP_AUTH_CHALLENGE_CODE]);
    const passwordResponse = await input.session.sendCommand(
      Buffer.from(input.password).toString('base64'),
    );
    assertResponseCode(passwordResponse, [SMTP_AUTH_SUCCESS_CODE]);
    return;
  }
  throw new Error('SMTP server does not advertise a supported authentication method');
}

function assertResponseCode(response: SmtpResponse, expectedCodes: readonly number[]): void {
  if (expectedCodes.includes(response.code)) {
    return;
  }
  throw new Error(`Unexpected SMTP response: ${response.lines.join(' | ')}`);
}

function supportsExtension(response: SmtpResponse, extension: string): boolean {
  return response.lines.some((line) => line.slice(4).trim().toUpperCase().startsWith(extension));
}

function getAuthenticationMethods(response: SmtpResponse): readonly string[] {
  const authenticationLine = response.lines.find((line) =>
    line.slice(4).trim().toUpperCase().startsWith('AUTH'),
  );
  if (!authenticationLine) {
    return [];
  }
  return authenticationLine
    .slice(4)
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((value) => value.toUpperCase());
}

async function closeSessionGracefully(session: SmtpSession): Promise<void> {
  try {
    const quitResponse = await session.sendCommand('QUIT');
    assertResponseCode(quitResponse, [SMTP_QUIT_CODE]);
  } catch {
    return;
  }
}

function createMimeMessage(input: {
  readonly message: SmtpMailMessage;
  readonly identityDomain: string;
}): string {
  const boundary = `rezeis-${randomBytes(12).toString('hex')}`;
  const headers = [
    `From: ${input.message.from}`,
    `To: ${input.message.to}`,
    `Subject: ${input.message.subject}`,
    input.message.replyTo === null ? null : `Reply-To: ${input.message.replyTo}`,
    `Date: ${new Date(Date.now()).toUTCString()}`,
    'MIME-Version: 1.0',
    `Message-ID: <${randomBytes(12).toString('hex')}@${input.identityDomain}>`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter((value): value is string => value !== null);
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    input.message.text,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    input.message.html,
    `--${boundary}--`,
  ];
  return [...headers, '', ...body].join(SMTP_NEWLINE);
}

function resolveSmtpIdentityDomain(input: {
  readonly explicitIdentityDomain: string | null;
  readonly fromAddress: string;
}): string {
  if (input.explicitIdentityDomain !== null) {
    return input.explicitIdentityDomain;
  }
  const [, domain] = input.fromAddress.split('@');
  if (!domain) {
    return 'localhost';
  }
  return domain;
}
