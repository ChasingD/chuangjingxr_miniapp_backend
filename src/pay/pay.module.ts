// src/pay/pay.module.ts
import { Module } from '@nestjs/common';
import { PayController } from './pay.controller';
import { PayService } from './pay.service';

@Module({
  controllers: [PayController],
  providers: [PayService],
  exports: [PayService],
})
export class PayModule {}
