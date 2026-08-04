import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class WechatCsService {
  private readonly logger = new Logger(WechatCsService.name);

  private get appId(): string {
    return process.env.WECHAT_APPID || '';
  }

  private get appSecret(): string {
    return process.env.WECHAT_APPSECRET || '';
  }

  private get token(): string {
    return process.env.WECHAT_CS_TOKEN || '';
  }

  private accessToken: string | null = null;
  private tokenExpireTime: number = 0;

  /** 验证微信服务器签名（URL 校验） */
  verifySignature(signature: string, timestamp: string, nonce: string): boolean {
    const arr = [this.token, timestamp, nonce].sort();
    const str = arr.join('');
    const sha1 = crypto.createHash('sha1').update(str).digest('hex');
    return sha1 === signature;
  }

  /** 获取微信 access_token */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpireTime) {
      return this.accessToken;
    }

    const appId = this.appId;
    const appSecret = this.appSecret;
    if (!appId || !appSecret) {
      this.logger.warn('WECHAT_APPID 或 WECHAT_APPSECRET 未配置');
      throw new Error('微信配置不完整，请设置 WECHAT_APPID 和 WECHAT_APPSECRET');
    }

    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`;
    const res = await fetch(url);
    const data = (await res.json()) as any;

    if (data.errcode) {
      this.logger.error(`获取 access_token 失败: ${JSON.stringify(data)}`);
      throw new Error(`获取 access_token 失败: ${data.errmsg}`);
    }

    this.accessToken = data.access_token;
    this.tokenExpireTime = Date.now() + (data.expires_in - 300) * 1000;
    this.logger.log('access_token 获取成功');
    return this.accessToken!;
  }

  /** 通过 login code 换取用户 OpenID */
  async code2Session(code: string): Promise<{ openid: string }> {
    const appId = this.appId;
    const appSecret = this.appSecret;
    if (!appId || !appSecret) {
      throw new Error('微信配置不完整');
    }

    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${appSecret}&js_code=${code}&grant_type=authorization_code`;
    const res = await fetch(url);
    const data = (await res.json()) as any;

    if (data.errcode) {
      this.logger.error(`code2session 失败: ${JSON.stringify(data)}`);
      throw new Error(`登录凭证校验失败: ${data.errmsg}`);
    }

    this.logger.log(`code2session 成功，openid=${data.openid}`);
    return { openid: data.openid };
  }

  /** 发送客服文本消息（含外链） */
  async sendLinkMessage(openId: string, linkUrl: string): Promise<boolean> {
    try {
      const accessToken = await this.getAccessToken();
      const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${accessToken}`;

      const content = `点击下方链接即可在浏览器中打开：\n\n${linkUrl}`;

      const body = {
        touser: openId,
        msgtype: 'text',
        text: { content },
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as any;

      if (data.errcode && data.errcode !== 0) {
        this.logger.error(`发送客服消息失败: ${JSON.stringify(data)}`);
        return false;
      }

      this.logger.log(`客服消息已发送给用户 ${openId}，链接: ${linkUrl}`);
      return true;
    } catch (err) {
      this.logger.error(`发送客服消息异常: ${(err as Error).message}`);
      return false;
    }
  }

  /** 解析微信推送 XML，提取关键字段 */
  parseXmlMessage(xml: string): { fromUserName: string; msgType: string; content: string } | null {
    try {
      const fromUserName = this.extractXmlValue(xml, 'FromUserName');
      const msgType = this.extractXmlValue(xml, 'MsgType');
      const content = this.extractXmlValue(xml, 'Content');
      if (!fromUserName || !msgType) return null;
      return { fromUserName, msgType, content };
    } catch {
      return null;
    }
  }

  private extractXmlValue(xml: string, tag: string): string {
    const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]></${tag}>`));
    if (match) return match[1];
    const match2 = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
    if (match2) return match2[1];
    return '';
  }

  generateSuccessResponse(): string {
    return '<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>';
  }
}
