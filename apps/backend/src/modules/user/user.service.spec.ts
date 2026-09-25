/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { UserService } from './user.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { DataSource, Repository } from 'typeorm';

describe('UserService', () => {
  let service: UserService;
  let userRepo: jest.Mocked<Repository<User>>;
  let refreshTokenRepo: jest.Mocked<Repository<RefreshToken>>;
  let mockDataSource: {
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    mockDataSource = {
      transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: {
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
    userRepo = module.get(getRepositoryToken(User));
    refreshTokenRepo = module.get(getRepositoryToken(RefreshToken));
  });

  const mockUser = { id: 'u1', walletAddress: 'GD...123', isActive: true };

  describe('findByWalletAddress', () => {
    it('should call findOne with correct params', async () => {
      userRepo.findOne.mockResolvedValue(mockUser as any);
      const result = await service.findByWalletAddress('GD...123');
      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { walletAddress: 'GD...123' },
      });
      expect(result).toEqual(mockUser);
    });
  });

  describe('findById', () => {
    it('should call findOne with correct params', async () => {
      userRepo.findOne.mockResolvedValue(mockUser as any);
      const result = await service.findById('u1');
      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'u1', isActive: true },
      });
      expect(result).toEqual(mockUser);
    });
  });

  describe('create', () => {
    it('should create and save a user', async () => {
      userRepo.create.mockReturnValue(mockUser as any);
      userRepo.save.mockResolvedValue(mockUser as any);
      const result = await service.create({ walletAddress: 'GD...123' });
      expect(userRepo.create).toHaveBeenCalled();
      expect(userRepo.save).toHaveBeenCalled();
      expect(result).toBe(mockUser);
    });
  });

  describe('update', () => {
    it('should update and return updated user', async () => {
      userRepo.update.mockResolvedValue({} as any);
      userRepo.findOne.mockResolvedValue(mockUser as any);
      const result = await service.update('u1', { isActive: false });
      expect(userRepo.update).toHaveBeenCalledWith('u1', { isActive: false });
      expect(result).toBe(mockUser);
    });

    it('should throw if user not found after update', async () => {
      userRepo.update.mockResolvedValue({} as any);
      userRepo.findOne.mockResolvedValue(null);
      await expect(service.update('u1', {})).rejects.toThrow('User not found');
    });
  });

  describe('refreshToken operations', () => {
    const mockToken = { token: 't1', user: mockUser };

    it('should create and save a refresh token', async () => {
      refreshTokenRepo.create.mockReturnValue(mockToken as any);
      refreshTokenRepo.save.mockResolvedValue(mockToken as any);
      const result = await service.createRefreshToken(mockToken as any);
      expect(result).toBe(mockToken);
    });

    it('should find refresh token', async () => {
      refreshTokenRepo.findOne.mockResolvedValue(mockToken as any);
      const result = await service.findRefreshToken('t1');
      expect(refreshTokenRepo.findOne).toHaveBeenCalledWith({
        where: { token: 't1', isActive: true },
        relations: ['user'],
      });
      expect(result).toBe(mockToken);
    });

    it('should invalidate refresh token', async () => {
      await service.invalidateRefreshToken('t1');
      expect(refreshTokenRepo.update).toHaveBeenCalledWith(
        { token: 't1' },
        { isActive: false },
      );
    });
  });

  describe('atomicRotateRefreshToken', () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60);
    const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    it('should consume old token and issue successor in one transaction', async () => {
      const consumedToken = {
        token: 'old-token',
        userId: 'u1',
        expiresAt: futureDate,
        isActive: false,
        user: { id: 'u1', walletAddress: 'GD...123', isActive: true },
      };

      const successor = {
        token: 'new-token',
        userId: 'u1',
        expiresAt: newExpiry,
        isActive: true,
      };

      mockDataSource.transaction.mockImplementation(
        async (_isolation: string, cb: (manager: any) => Promise<any>) => {
          const manager = {
            createQueryBuilder: jest.fn().mockReturnValue({
              update: jest.fn().mockReturnThis(),
              set: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              execute: jest.fn().mockResolvedValue({ affected: 1 }),
            }),
            findOne: jest.fn().mockResolvedValue(consumedToken),
            create: jest.fn().mockReturnValue(successor),
            save: jest.fn().mockResolvedValue(successor),
          };
          return cb(manager);
        },
      );

      const result = await service.atomicRotateRefreshToken(
        'old-token',
        'new-token',
        newExpiry,
      );

      expect(result.consumed).toEqual(consumedToken);
      expect(result.newToken).toBe('new-token');
      expect(result.newExpiresAt).toBe(newExpiry);
      expect(mockDataSource.transaction).toHaveBeenCalledWith(
        'SERIALIZABLE',
        expect.any(Function),
      );
    });

    it('should throw REFRESH_TOKEN_ALREADY_CONSUMED when token is inactive', async () => {
      mockDataSource.transaction.mockImplementation(
        async (_isolation: string, cb: (manager: any) => Promise<any>) => {
          const manager = {
            createQueryBuilder: jest.fn().mockReturnValue({
              update: jest.fn().mockReturnThis(),
              set: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              execute: jest.fn().mockResolvedValue({ affected: 0 }),
            }),
          };
          return cb(manager);
        },
      );

      await expect(
        service.atomicRotateRefreshToken('old-token', 'new-token', newExpiry),
      ).rejects.toThrow('REFRESH_TOKEN_ALREADY_CONSUMED');
    });

    it('should throw REFRESH_TOKEN_EXPIRED when token has expired', async () => {
      const expiredToken = {
        token: 'old-token',
        userId: 'u1',
        expiresAt: new Date(0), // expired
        isActive: false,
        user: { id: 'u1', walletAddress: 'GD...123', isActive: true },
      };

      mockDataSource.transaction.mockImplementation(
        async (_isolation: string, cb: (manager: any) => Promise<any>) => {
          const manager = {
            createQueryBuilder: jest.fn().mockReturnValue({
              update: jest.fn().mockReturnThis(),
              set: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              execute: jest.fn().mockResolvedValue({ affected: 1 }),
            }),
            findOne: jest.fn().mockResolvedValue(expiredToken),
          };
          return cb(manager);
        },
      );

      await expect(
        service.atomicRotateRefreshToken('old-token', 'new-token', newExpiry),
      ).rejects.toThrow('REFRESH_TOKEN_EXPIRED');
    });

    it('should throw USER_INACTIVE when user is deactivated', async () => {
      const tokenWithInactiveUser = {
        token: 'old-token',
        userId: 'u1',
        expiresAt: futureDate,
        isActive: false,
        user: { id: 'u1', walletAddress: 'GD...123', isActive: false },
      };

      mockDataSource.transaction.mockImplementation(
        async (_isolation: string, cb: (manager: any) => Promise<any>) => {
          const manager = {
            createQueryBuilder: jest.fn().mockReturnValue({
              update: jest.fn().mockReturnThis(),
              set: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              execute: jest.fn().mockResolvedValue({ affected: 1 }),
            }),
            findOne: jest.fn().mockResolvedValue(tokenWithInactiveUser),
          };
          return cb(manager);
        },
      );

      await expect(
        service.atomicRotateRefreshToken('old-token', 'new-token', newExpiry),
      ).rejects.toThrow('USER_INACTIVE');
    });
  });
});
