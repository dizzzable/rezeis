#!/usr/bin/env node
/**
 * rezeis-admin Admin CLI
 * ──────────────────────
 *
 * Standalone, NestJS-free recovery tool that talks directly to the same
 * PostgreSQL database the running app uses. Designed for the case where
 * the operator can't reach the web panel (forgot password, lost 2FA,
 * IP allowlist locked them out) and needs to reset state from the
 * server console.
 *
 * Usage
 *   node --import tsx scripts/admin-cli.ts <command> [args]
 *   pnpm  ts-node       scripts/admin-cli.ts <command> [args]
 *   ts-node             scripts/admin-cli.ts <command> [args]
 *
 * Commands
 *   list                                — Lists all admin accounts.
 *   create-superadmin <login> <pwd>     — Creates a DEV superadmin.
 *   reset-password <login> <pwd>        — Resets the password and forces a
 *                                          change on next sign-in.
 *   disable-2fa <login>                 — Removes the TOTP factor + recovery
 *                                          codes for the named admin.
 *   clear-ip-allowlist                  — Empties the admin IP allowlist
 *                                          (so anyone with valid creds can
 *                                          sign in again).
 *   bump-token-version <login>          — Invalidates every outstanding JWT
 *                                          for the named admin.
 *
 * Environment
 *   DATABASE_URL must point at the same PostgreSQL instance the panel
 *   uses. The CLI reads it directly — no other env vars required.
 *
 * Why a separate file?
 *   Rather than wire NestFactory and bootstrap the whole DI graph just
 *   to call a couple of services, we use Prisma + the same scrypt
 *   primitives PasswordHashService uses. That keeps startup latency
 *   well under a second and guarantees the CLI runs even when the app
 *   is broken (bad config, missing modules, etc.).
 */

import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const scryptAsync = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keyLen: number,
) => Promise<Buffer>;

const HASH_KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0) {
    return process.env.DATABASE_URL;
  }
  const host = process.env.DATABASE_HOST ?? 'localhost';
  const port = process.env.DATABASE_PORT ?? '5432';
  const name = process.env.DATABASE_NAME ?? 'rezeis';
  const user = process.env.DATABASE_USER ?? 'rezeis';
  const password = encodeURIComponent(process.env.DATABASE_PASSWORD ?? '');
  return `postgresql://${user}:${password}@${host}:${port}/${name}`;
}

function buildPrisma(): PrismaClient {
  // Mirror PrismaService construction so the CLI works against the same
  // Prisma 7 adapter / connection-string resolution as the running app.
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: resolveDatabaseUrl() }),
  });
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command) {
    printHelp();
    process.exit(1);
  }

  const prisma = buildPrisma();
  try {
    switch (command) {
      case 'list':
        await commandList(prisma);
        break;
      case 'create-superadmin':
        await commandCreateSuperadmin(prisma, args);
        break;
      case 'reset-password':
        await commandResetPassword(prisma, args);
        break;
      case 'disable-2fa':
        await commandDisable2fa(prisma, args);
        break;
      case 'clear-ip-allowlist':
        await commandClearIpAllowlist(prisma);
        break;
      case 'bump-token-version':
        await commandBumpTokenVersion(prisma, args);
        break;
      case '-h':
      case '--help':
      case 'help':
        printHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

function printHelp(): void {
  console.log(`
rezeis-admin Admin CLI

Commands:
  list                                   List admin accounts.
  create-superadmin <login> <password>   Create a DEV superadmin.
  reset-password <login> <password>      Reset password (forces change on login).
  disable-2fa <login>                    Remove the TOTP factor.
  clear-ip-allowlist                     Empty the admin IP allowlist.
  bump-token-version <login>             Invalidate every outstanding JWT.
`);
}

async function commandList(prisma: PrismaClient): Promise<void> {
  const admins = await prisma.adminUser.findMany({
    select: {
      id: true,
      login: true,
      email: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
      lastLoginIp: true,
      mustChangePassword: true,
      totpEnabled: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  if (admins.length === 0) {
    console.log('No admin accounts found.');
    return;
  }
  for (const admin of admins) {
    const flags: string[] = [];
    if (!admin.isActive) flags.push('INACTIVE');
    if (admin.mustChangePassword) flags.push('MUST-CHANGE-PWD');
    if (admin.totpEnabled) flags.push('2FA');
    const last = admin.lastLoginAt
      ? `${admin.lastLoginAt.toISOString()} (${admin.lastLoginIp ?? '?'})`
      : 'never';
    console.log(
      [
        admin.id.slice(0, 8),
        admin.login.padEnd(20),
        (admin.email ?? '').padEnd(30),
        admin.role.padEnd(6),
        flags.join('|').padEnd(20),
        `last: ${last}`,
      ].join('  '),
    );
  }
}

async function commandCreateSuperadmin(
  prisma: PrismaClient,
  args: string[],
): Promise<void> {
  const [login, password] = args;
  if (!login || !password) {
    console.error('Usage: create-superadmin <login> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  const normalized = login.trim().toLowerCase();
  const existing = await prisma.adminUser.findUnique({
    where: { loginNormalized: normalized },
    select: { id: true },
  });
  if (existing) {
    console.error(`Admin with login "${login}" already exists (id=${existing.id}).`);
    process.exit(1);
  }
  const passwordHash = await hashPassword(password);
  const created = await prisma.adminUser.create({
    data: {
      login,
      loginNormalized: normalized,
      passwordHash,
      role: 'DEV',
      isActive: true,
      mustChangePassword: false,
    },
    select: { id: true, login: true },
  });
  console.log(`Created superadmin: ${created.login} (id=${created.id})`);
}

async function commandResetPassword(prisma: PrismaClient, args: string[]): Promise<void> {
  const [login, password] = args;
  if (!login || !password) {
    console.error('Usage: reset-password <login> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  const normalized = login.trim().toLowerCase();
  const admin = await prisma.adminUser.findUnique({
    where: { loginNormalized: normalized },
    select: { id: true, tokenVersion: true },
  });
  if (!admin) {
    console.error(`Admin with login "${login}" not found.`);
    process.exit(1);
  }
  const passwordHash = await hashPassword(password);
  await prisma.adminUser.update({
    where: { id: admin.id },
    data: {
      passwordHash,
      passwordChangedAt: new Date(),
      mustChangePassword: true,
      tokenVersion: admin.tokenVersion + 1,
    },
  });
  console.log(`Password reset for "${login}". Operator will be forced to change it on next sign-in.`);
}

async function commandDisable2fa(prisma: PrismaClient, args: string[]): Promise<void> {
  const [login] = args;
  if (!login) {
    console.error('Usage: disable-2fa <login>');
    process.exit(1);
  }
  const normalized = login.trim().toLowerCase();
  const admin = await prisma.adminUser.findUnique({
    where: { loginNormalized: normalized },
    select: { id: true, totpEnabled: true },
  });
  if (!admin) {
    console.error(`Admin with login "${login}" not found.`);
    process.exit(1);
  }
  if (!admin.totpEnabled) {
    console.log(`2FA is already disabled for "${login}".`);
    return;
  }
  await prisma.adminUser.update({
    where: { id: admin.id },
    data: {
      totpEnabled: false,
      totpSecretEncrypted: null,
      totpRecoveryCodes: [],
      totpEnrolledAt: null,
    },
  });
  console.log(`2FA removed for "${login}".`);
}

async function commandClearIpAllowlist(prisma: PrismaClient): Promise<void> {
  const { count } = await prisma.adminIpAllowlist.deleteMany({});
  console.log(`Cleared admin IP allowlist (${count} entries removed).`);
}

async function commandBumpTokenVersion(prisma: PrismaClient, args: string[]): Promise<void> {
  const [login] = args;
  if (!login) {
    console.error('Usage: bump-token-version <login>');
    process.exit(1);
  }
  const normalized = login.trim().toLowerCase();
  const admin = await prisma.adminUser.findUnique({
    where: { loginNormalized: normalized },
    select: { id: true, tokenVersion: true },
  });
  if (!admin) {
    console.error(`Admin with login "${login}" not found.`);
    process.exit(1);
  }
  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { tokenVersion: admin.tokenVersion + 1 },
  });
  console.log(`Token version bumped for "${login}". All outstanding JWTs are now invalid.`);
}

async function hashPassword(plainText: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(plainText, salt, HASH_KEY_LENGTH);
  return ['scrypt', salt.toString('hex'), derived.toString('hex')].join('$');
}

main().catch((err) => {
  console.error('CLI failed:', err);
  process.exit(1);
});
