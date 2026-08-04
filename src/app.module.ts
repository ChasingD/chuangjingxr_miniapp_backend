import { Module } from '@nestjs/common';
import { AppController } from '@/app.controller';
import { AppService } from '@/app.service';
import { WechatCsModule } from '@/wechat-cs/wechat-cs.module';

@Module({
  imports: [WechatCsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
