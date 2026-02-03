import crypto from 'crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Pool } from 'pg';
import { getEnv } from '../../config/env.js';
import { UserRepository } from '../../repositories/index.js';
import { hashPassword, comparePassword } from '../../utils/password.js';
import { logger } from '../../utils/logger.js';
import type { LoginInput, RegisterInput, LoginResponse, UserResponse, TelegramUserData, TelegramAuthResult } from './auth.schemas.js';
import type { CreateUserDTO, User } from '../../entities/user.entity.js';

/**
 * JWT payload interface
 */
interface JwtPayload {
  userId: string;
  username: string;
  role: string;
}

/**
 * Custom error for invalid Telegram data
 */
export class InvalidTelegramDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTelegramDataError';
  }
}

/**
 * Authentication error
 */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/**
 * Auth service configuration
 */
interface AuthServiceConfig {
  userRepository: UserRepository;
}

/**
 * Auth service factory
 * Creates an auth service instance with the given database pool
 * @param db - PostgreSQL pool instance
 * @returns Auth service methods
 */
export function createAuthService(db: Pool) {
  const userRepository = new UserRepository(db);
  return new AuthService({ userRepository });
}

/**
 * Auth service class
 * Handles all authentication-related operations
 */
class AuthService {
  private readonly userRepository: UserRepository;

  constructor(config: AuthServiceConfig) {
    this.userRepository = config.userRepository;
  }

  /**
   * Generate JWT token
   * @param payload - JWT payload
   * @returns JWT token string
   */
  generateToken(payload: JwtPayload): string {
    const env = getEnv();
    const options: SignOptions = { expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'] };
    return jwt.sign(payload, env.JWT_SECRET, options);
  }

  /**
   * Verify JWT token
   * @param token - JWT token string
   * @returns Decoded payload
   * @throws Error if token is invalid
   */
  verifyToken(token: string): JwtPayload {
    const env = getEnv();
    return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  }

  /**
   * Map User entity to UserResponse
   * @param user - User entity
   * @returns User response object
   */
  private mapUserToResponse(user: { id: string; username: string; firstName?: string; lastName?: string; role: string; createdAt: Date; updatedAt: Date }): UserResponse {
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username;
    return {
      id: user.id,
      username: user.username,
      name,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  /**
   * Parse initData string from Telegram WebApp
   * @param initData - Raw initData string from Telegram
   * @returns Parsed key-value pairs
   */
  private parseInitData(initData: string): Map<string, string> {
    const params = new Map<string, string>();
    const pairs = initData.split('&');

    for (const pair of pairs) {
      const [key, value] = pair.split('=');
      if (key && value !== undefined) {
        params.set(decodeURIComponent(key), decodeURIComponent(value));
      }
    }

    return params;
  }

  /**
   * Verify Telegram WebApp initData signature
   * @param params - Parsed initData parameters
   * @param botToken - Telegram bot token
   * @returns True if signature is valid
   */
  private verifyTelegramSignature(params: Map<string, string>, botToken: string): boolean {
    const hash = params.get('hash');
    if (!hash) {
      return false;
    }

    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(computedHash));
  }

  /**
   * Parse Telegram user data from initData
   * @param userJson - User data JSON string from initData
   * @returns Parsed user data
   * @throws InvalidTelegramDataError if user data is invalid
   */
  private parseTelegramUser(userJson: string): TelegramUserData {
    try {
      const user = JSON.parse(userJson) as TelegramUserData;
      if (!user.id || !user.first_name) {
        throw new InvalidTelegramDataError('Invalid user data: missing id or first_name');
      }
      return user;
    } catch {
      throw new InvalidTelegramDataError('Failed to parse user data');
    }
  }

  /**
   * Verify Telegram WebApp authentication
   * @param params - Object containing initData string
   * @returns Authentication result with token and user data
   * @throws InvalidTelegramDataError if Telegram data is invalid
   */
  async verifyTelegramAuth(params: { initData: string }): Promise<TelegramAuthResult> {
    const { initData } = params;
    const env = getEnv();

    if (!initData) {
      throw new InvalidTelegramDataError('initData is required');
    }

    const dataParams = this.parseInitData(initData);
    const isValid = this.verifyTelegramSignature(dataParams, env.TELEGRAM_BOT_TOKEN);

    if (!isValid) {
      logger.warn('Telegram authentication failed: invalid signature');
      throw new InvalidTelegramDataError('Invalid Telegram signature');
    }

    const userJson = dataParams.get('user');
    if (!userJson) {
      throw new InvalidTelegramDataError('User data not found in initData');
    }

    const telegramUser = this.parseTelegramUser(userJson);
    const user = await this.userRepository.findOrCreateFromTelegram(
      telegramUser.id.toString(),
      {
        username: telegramUser.username,
        firstName: telegramUser.first_name,
        lastName: telegramUser.last_name,
        photoUrl: telegramUser.photo_url,
      }
    );

    await this.userRepository.updateLastLogin(user.id);

    const token = this.generateToken({
      userId: user.id,
      username: user.username,
      role: user.role,
    });

    logger.info({ userId: user.id, telegramId: telegramUser.id }, 'User authenticated via Telegram');

    return {
      token,
      user: this.mapUserToResponse(user),
    };
  }

  /**
   * Login user
   * @param data - Login credentials
   * @returns Login response with token and user
   * @throws AuthenticationError if credentials are invalid
   */
  async loginUser(data: LoginInput): Promise<LoginResponse> {
    const user = await this.userRepository.findByUsername(data.username);

    if (!user) {
      logger.warn({ username: data.username }, 'Login attempt with non-existent username');
      throw new AuthenticationError('Invalid credentials');
    }

    if (!user.passwordHash) {
      logger.warn({ username: data.username }, 'Login attempt for user without password');
      throw new AuthenticationError('Invalid credentials');
    }

    const isPasswordValid = await comparePassword(data.password, user.passwordHash);

    if (!isPasswordValid) {
      logger.warn({ username: data.username }, 'Login attempt with invalid password');
      throw new AuthenticationError('Invalid credentials');
    }

    await this.userRepository.updateLastLogin(user.id);

    const token = this.generateToken({
      userId: user.id,
      username: user.username,
      role: user.role,
    });

    logger.info({ userId: user.id }, 'User logged in successfully');

    return {
      token,
      user: this.mapUserToResponse(user),
    };
  }

  /**
   * Register new user
   * @param data - Registration data
   * @returns Login response with token and user
   * @throws AuthenticationError if username already exists
   */
  async registerUser(data: RegisterInput): Promise<LoginResponse> {
    const existingUser = await this.userRepository.findByUsername(data.username);

    if (existingUser) {
      logger.warn({ username: data.username }, 'Registration attempt with existing username');
      throw new AuthenticationError('Username already registered');
    }

    const passwordHash = await hashPassword(data.password);

    const createData: CreateUserDTO = {
      username: data.username,
      passwordHash,
      firstName: data.name,
      role: 'user',
      isActive: true,
    };

    const user = await this.userRepository.create(createData);

    const token = this.generateToken({
      userId: user.id,
      username: user.username,
      role: user.role,
    });

    logger.info({ userId: user.id }, 'User registered successfully');

    return {
      token,
      user: this.mapUserToResponse(user),
    };
  }

  /**
   * Get current user by ID
   * @param userId - User ID
   * @returns User response or null
   */
  async getCurrentUser(userId: string): Promise<UserResponse | null> {
    const user = await this.userRepository.findById(userId);
    return user ? this.mapUserToResponse(user) : null;
  }

  /**
   * Create super admin user
   * @param data - Super admin creation data
   * @returns Created user
   * @throws AuthenticationError if username already exists
   */
  async createSuperAdmin(data: {
    username: string;
    password: string;
    telegramId: string;
  }): Promise<User> {
    const existingUser = await this.userRepository.findByUsername(data.username);

    if (existingUser) {
      logger.warn({ username: data.username }, 'Super admin creation attempt with existing username');
      throw new AuthenticationError('Username already exists');
    }

    const passwordHash = await hashPassword(data.password);

    const createData: CreateUserDTO = {
      username: data.username,
      passwordHash,
      telegramId: data.telegramId,
      role: 'admin',
      isActive: true,
    };

    const user = await this.userRepository.create(createData);

    logger.info({ userId: user.id }, 'Super admin created successfully');

    return user;
  }
}

// Export individual functions for backward compatibility
export function generateToken(payload: JwtPayload): string {
  const env = getEnv();
  const options: SignOptions = { expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'] };
  return jwt.sign(payload, env.JWT_SECRET, options);
}

export function verifyToken(token: string): JwtPayload {
  const env = getEnv();
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}

export async function verifyTelegramAuth(params: { initData: string }): Promise<TelegramAuthResult> {
  void params;
  throw new Error('verifyTelegramAuth requires database pool. Use createAuthService instead.');
}

export async function loginUser(data: LoginInput): Promise<LoginResponse> {
  void data;
  throw new Error('loginUser requires database pool. Use createAuthService instead.');
}

export async function registerUser(data: RegisterInput): Promise<LoginResponse> {
  void data;
  throw new Error('registerUser requires database pool. Use createAuthService instead.');
}

export async function getCurrentUser(userId: string): Promise<UserResponse | null> {
  void userId;
  throw new Error('getCurrentUser requires database pool. Use createAuthService instead.');
}
