import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';

/**
 * Result of an atomic refresh-token rotation.
 * Contains the consumed token (with its user relation) and the
 * newly-issued successor token value.
 */
export interface RotationResult {
  /** The consumed token row (includes `.user` relation). */
  consumed: RefreshToken;
  /** The raw hex string of the newly-issued successor token. */
  newToken: string;
  /** The expiry date of the newly-issued successor token. */
  newExpiresAt: Date;
}

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private refreshTokenRepository: Repository<RefreshToken>,
    private dataSource: DataSource,
  ) {}

  async findByWalletAddress(walletAddress: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { walletAddress } });
  }

  async findById(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id, isActive: true } });
  }

  async create(userData: Partial<User>): Promise<User> {
    const user = this.userRepository.create(userData);
    return this.userRepository.save(user);
  }

  async update(id: string, userData: Partial<User>): Promise<User> {
    await this.userRepository.update(id, userData);
    const user = await this.findById(id);
    if (!user) {
      throw new Error('User not found');
    }
    return user;
  }

  async save(user: User): Promise<User> {
    return this.userRepository.save(user);
  }

  async createRefreshToken(
    tokenData: Partial<RefreshToken>,
  ): Promise<RefreshToken> {
    const refreshToken = this.refreshTokenRepository.create(tokenData);
    return this.refreshTokenRepository.save(refreshToken);
  }

  async findRefreshToken(token: string): Promise<RefreshToken | null> {
    return this.refreshTokenRepository.findOne({
      where: { token, isActive: true },
      relations: ['user'],
    });
  }

  async invalidateRefreshToken(token: string): Promise<void> {
    await this.refreshTokenRepository.update({ token }, { isActive: false });
  }

  /**
   * Atomically consume a refresh token and issue its successor inside a
   * single serialised transaction.
   *
   * Guarantees:
   * 1. Only one caller wins when concurrent requests present the same token.
   * 2. Inactive users or revoked/expired tokens are rejected.
   * 3. On rollback (e.g. DB error) neither consumption nor issuance persists.
   *
   * @param tokenValue  The raw refresh-token hex string sent by the client.
   * @param newTokenValue  The pre-generated hex string for the successor token.
   * @param newExpiresAt  Expiry timestamp for the successor token.
   * @returns A `RotationResult` on success.
   * @throws Error with a descriptive message on any failure.
   */
  async atomicRotateRefreshToken(
    tokenValue: string,
    newTokenValue: string,
    newExpiresAt: Date,
  ): Promise<RotationResult> {
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      // ----- Step 1: Conditionally consume the token -----
      // Use an UPDATE … WHERE to atomically flip isActive only if the token
      // is still active. The affected-row count tells us whether we won the
      // race (exactly 1) or lost (0).
      const updateResult = await manager
        .createQueryBuilder()
        .update(RefreshToken)
        .set({ isActive: false })
        .where('token = :token AND isActive = :active', {
          token: tokenValue,
          active: true,
        })
        .execute();

      if (!updateResult.affected || updateResult.affected === 0) {
        throw new Error('REFRESH_TOKEN_ALREADY_CONSUMED');
      }

      // ----- Step 2: Load the consumed row + user relation -----
      const consumed = await manager.findOne(RefreshToken, {
        where: { token: tokenValue },
        relations: ['user'],
      });

      if (!consumed) {
        // Should never happen after a successful UPDATE, but guard anyway.
        throw new Error('REFRESH_TOKEN_NOT_FOUND');
      }

      // ----- Step 3: Validate token expiry -----
      if (consumed.expiresAt < new Date()) {
        // Token was already expired; the UPDATE above deactivated it (good
        // hygiene) but we still reject the rotation.
        throw new Error('REFRESH_TOKEN_EXPIRED');
      }

      // ----- Step 4: Validate the owning user is still active -----
      if (!consumed.user || !consumed.user.isActive) {
        this.logger.warn({
          msg: 'Refresh rotation rejected for inactive user',
          userId: consumed.userId,
        });
        throw new Error('USER_INACTIVE');
      }

      // ----- Step 5: Issue the successor token -----
      const successor = manager.create(RefreshToken, {
        token: newTokenValue,
        userId: consumed.userId,
        expiresAt: newExpiresAt,
        isActive: true,
      });
      await manager.save(successor);

      return {
        consumed,
        newToken: newTokenValue,
        newExpiresAt,
      };
    });
  }
}
