import { Module, Global, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import stellarConfig from '../../config/stellar.config';
import { StellarService } from '../../services/stellar.service';
import { EscrowOperationsService } from '../../services/stellar/escrow-operations';
import { SorobanClientService } from '../../services/stellar/soroban-client.service';
import { SorobanBridgeService } from '../../services/stellar/soroban-bridge.service';
import { Escrow } from '../escrow/entities/escrow.entity';
import { AdminModule } from '../admin/admin.module';

@Global()
@Module({
  imports: [
    ConfigModule.forFeature(stellarConfig),
    TypeOrmModule.forFeature([Escrow]),
    forwardRef(() => AdminModule),
  ],
  providers: [
    StellarService,
    EscrowOperationsService,
    SorobanClientService,
    SorobanBridgeService,
  ],
  exports: [
    StellarService,
    EscrowOperationsService,
    SorobanClientService,
    SorobanBridgeService,
    ConfigModule.forFeature(stellarConfig),
  ],
})
export class StellarModule {}
