import { Module } from '@nestjs/common';
import { WechatCsController } from './wechat-cs.controller';
import { WechatCsService } from './wechat-cs.service';

@Module({
  controllers: [WechatCsController],
  providers: [WechatCsService],
  exports: [WechatCsService],
})
export class WechatCsModule {}
