import { Controller, Get, Post, Query, Req, Res, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { WechatCsService } from './wechat-cs.service';

@Controller('wechat-cs')
export class WechatCsController {
  private readonly logger = new Logger(WechatCsController.name);

  constructor(private readonly wechatCsService: WechatCsService) {}

  /** 微信服务器 URL 校验（GET） */
  @Get()
  verifyUrl(
    @Query('signature') signature: string,
    @Query('timestamp') timestamp: string,
    @Query('nonce') nonce: string,
    @Query('echostr') echostr: string,
    @Res() res: Response,
  ) {
    this.logger.log(`URL 校验: signature=${signature}`);
    if (this.wechatCsService.verifySignature(signature, timestamp, nonce)) {
      this.logger.log('URL 校验通过');
      res.send(echostr);
    } else {
      this.logger.warn('URL 校验失败');
      res.status(403).send('Forbidden');
    }
  }

  /** 接收微信客服消息回调（POST）——用户进入客服会话时自动下发链接 */
  @Post()
  async handleEvent(@Req() req: Request, @Res() res: Response) {
    const xml = req.body?.toString() || '';
    this.logger.log(`客服回调: ${xml.substring(0, 200)}`);

    const parsed = this.wechatCsService.parseXmlMessage(xml);
    if (parsed) {
      this.logger.log(`解析: from=${parsed.fromUserName}, type=${parsed.msgType}`);
      if (parsed.msgType === 'event' || parsed.msgType === 'text') {
        // 异步下发，不阻塞响应
        const defaultLink = process.env.CS_DEFAULT_LINK || 'https://www.baidu.com';
        this.wechatCsService.sendLinkMessage(parsed.fromUserName, defaultLink)
          .then(ok => this.logger.log(ok ? '自动下发成功' : '自动下发失败'))
          .catch(err => this.logger.error(`自动下发异常: ${err.message}`));
      }
    }

    res.set('Content-Type', 'application/xml');
    res.send(this.wechatCsService.generateSuccessResponse());
  }

  /** 通过小程序 login code 发送客服消息（前端 onClick 调用） */
  @Post('send-by-code')
  async sendByCode(@Req() req: Request) {
    const { code, linkUrl } = req.body as any;
    if (!code) {
      return { code: 400, msg: '缺少 code 参数', data: null };
    }

    try {
      const session = await this.wechatCsService.code2Session(code);
      const finalLink = linkUrl || 'https://www.baidu.com';
      const success = await this.wechatCsService.sendLinkMessage(session.openid, finalLink);
      if (success) {
        return { code: 200, msg: '消息已发送', data: { openid: session.openid } };
      }
      return { code: 500, msg: '消息发送失败', data: null };
    } catch (err: any) {
      this.logger.error(`sendByCode 异常: ${err.message}`);
      return { code: 500, msg: err.message || '发送失败', data: null };
    }
  }

  /** 获取配置状态 */
  @Get('config-status')
  getConfigStatus() {
    return {
      code: 200,
      msg: 'ok',
      data: {
        appIdConfigured: !!process.env.WECHAT_APPID,
        appSecretConfigured: !!process.env.WECHAT_APPSECRET,
        tokenConfigured: !!process.env.WECHAT_CS_TOKEN,
      },
    };
  }
}
