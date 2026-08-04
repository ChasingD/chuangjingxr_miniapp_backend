// src/pay/pay.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import { db } from '@/db';
import { orders, NewOrder } from '@/db/schema/orders';
import { eq } from 'drizzle-orm';

// ============ 价目表（后端定价，不信任前端价格） ============

const SCENE_PRICES: Record<string, number> = {
  'scene-2': 699,  // ¥6.99
  'scene-7': 699,  // ¥6.99
};

const PRODUCT_PRICES: Record<string, Record<string, number>> = {
  vip_count: {
    'vip-1': 1000,   // ¥10
    'vip-10': 8000,  // ¥80
    'vip-30': 18000, // ¥180
  },
  vip_duration: {
    'vip-monthly': 9800, // ¥98
  },
  scene_purchase: SCENE_PRICES,
};

const PRODUCT_NAMES: Record<string, Record<string, string>> = {
  vip_count: {
    'vip-1': '单次VIP权益体验包',
    'vip-10': '10次VIP权益优惠包',
    'vip-30': '30次VIP权益超值包',
  },
  vip_duration: {
    'vip-monthly': '连续包月VIP会员',
  },
  scene_purchase: {
    'scene-2': '场景体验-科技馆探索',
    'scene-7': '场景体验-艺术展',
  },
};

// ============ 配置 ============

function getConfig() {
  const mchid = process.env.WECHAT_PAY_MCHID || '';
  const apiV3Key = process.env.WECHAT_PAY_API_V3_KEY || '';
  const serialNo = process.env.WECHAT_PAY_SERIAL_NO || '';
  const privateKeyPath = process.env.WECHAT_PAY_PRIVATE_KEY_PATH || '';
  const publicKeyPath = process.env.WECHAT_PAY_PUBLIC_KEY_PATH || '';
  const notifyUrl = process.env.WECHAT_PAY_NOTIFY_URL || '';
  const appId = process.env.WECHAT_APPID || '';

  return { mchid, apiV3Key, serialNo, privateKeyPath, publicKeyPath, notifyUrl, appId };
}

function loadPrivateKey(): string {
  const config = getConfig();
  if (!config.privateKeyPath) throw new Error('WECHAT_PAY_PRIVATE_KEY_PATH 未配置');
  const fs = require('fs');
  return fs.readFileSync(config.privateKeyPath, 'utf8');
}

function loadPublicKey(): string {
  const config = getConfig();
  if (!config.publicKeyPath) throw new Error('WECHAT_PAY_PUBLIC_KEY_PATH 未配置');
  const fs = require('fs');
  return fs.readFileSync(config.publicKeyPath, 'utf8');
}

// ============ 签名工具 ============

function signSHA256RSA(data: string, privateKey: string): string {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(data);
  sign.end();
  return sign.sign(privateKey, 'base64');
}

function verifySHA256RSA(data: string, signature: string, publicKey: string): boolean {
  const verify = crypto.createVerify('RSA-SHA256');
  verify.update(data);
  verify.end();
  return verify.verify(publicKey, signature, 'base64');
}

/**
 * 构造 WECHATPAY2-SHA256-RSA2048 签名头
 * 签名串格式: method\nurl\ntimestamp\nnonce\nbody\n
 */
function buildAuthorization(
  method: string, urlPath: string, body: string, mchid: string, serialNo: string, privateKey: string,
): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex').substring(0, 32);
  const signStr = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = signSHA256RSA(signStr, privateKey);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${serialNo}",signature="${signature}"`;
}

// ============ AES-256-GCM 解密（回调通知 resource 解密） ============

function decryptResource(nonce: string, ciphertext: string, associatedData: string, apiV3Key: string): string {
  const authTag = Buffer.from(ciphertext.slice(-32), 'hex');
  const encryptedData = ciphertext.slice(0, -32);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(apiV3Key),
    Buffer.from(nonce),
  );
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(associatedData));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedData, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// ============ 构造小程序 prepay 签名 ============

function buildPrepaySign(appId: string, mchid: string, prepayId: string, privateKey: string) {
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(16).toString('hex').substring(0, 32);
  const packageStr = `prepay_id=${prepayId}`;
  // 小程序调起支付的签名串：appId\n时间戳\n随机串\nprepay_id=...
  const signStr = `${appId}\n${timeStamp}\n${nonceStr}\n${packageStr}\n`;
  const sign = signSHA256RSA(signStr, privateKey);
  return { prepayId, nonceStr, timeStamp, signType: 'RSA', sign };
}

// ============ Service ============

@Injectable()
export class PayService {
  private readonly logger = new Logger(PayService.name);

  private getAmount(productType: string, productId: string): number {
    const category = PRODUCT_PRICES[productType];
    if (!category) throw new Error(`未知商品类型: ${productType}`);
    const amount = category[productId];
    if (!amount) throw new Error(`未知商品: ${productType}/${productId}`);
    return amount;
  }

  private getDescription(productType: string, productId: string): string {
    const category = PRODUCT_NAMES[productType];
    if (!category) return '创境XR服务';
    return category[productId] || '创境XR服务';
  }

  /**
   * 创建订单并返回小程序调起支付所需参数
   */
  async createOrder(
    openid: string, productType: string, productId: string,
  ): Promise<{ prepayId: string; nonceStr: string; timeStamp: string; signType: string; sign: string; orderId: string }> {
    const config = getConfig();
    const amount = this.getAmount(productType, productId);
    const description = this.getDescription(productType, productId);
    const orderId = uuidv4().replace(/-/g, ''); // 去掉横线，outTradeNo 与 orderId 一致

    // 1. 写订单到数据库
    const newOrder: NewOrder = {
      id: orderId,
      openid,
      productType,
      productId,
      amount,
      status: 'pending',
    };
    await db.insert(orders).values(newOrder);

    this.logger.log(`订单创建: id=${orderId}, type=${productType}, pid=${productId}, amount=${amount}分`);

    // 2. 调微信 JSAPI 下单
    const jsapiBody = JSON.stringify({
      appid: config.appId,
      mchid: config.mchid,
      description,
      out_trade_no: orderId,
      notify_url: config.notifyUrl,
      amount: { total: amount, currency: 'CNY' },
      payer: { openid },
    });

    const urlPath = '/v3/pay/transactions/jsapi';
    const privateKey = loadPrivateKey();
    const authHeader = buildAuthorization('POST', urlPath, jsapiBody, config.mchid, config.serialNo, privateKey);

    const jsapiResp = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': authHeader,
        'User-Agent': 'chuangjingxr/1.0',
      },
      body: jsapiBody,
    });

    const jsapiData = (await jsapiResp.json()) as any;
    if (jsapiData.prepay_id) {
      // 3. 回存 prepay_id
      await db.update(orders).set({ prepayId: jsapiData.prepay_id }).where(eq(orders.id, orderId));
      const prepayParams = buildPrepaySign(config.appId, config.mchid, jsapiData.prepay_id, privateKey);
      return { ...prepayParams, orderId };
    }

    this.logger.error(`微信 JSAPI 下单失败: ${JSON.stringify(jsapiData)}`);
    // 更新订单状态为取消
    await db.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, orderId));
    throw new Error(jsapiData.message || '微信支付下单失败');
  }

  /**
   * 处理微信支付回调通知
   */
  async handleNotify(headers: Record<string, string>, rawBody: string): Promise<{ success: boolean; message: string }> {
    const config = getConfig();

    // 1. 验签
    const signatureHeader = headers['wechatpay-signature'] || '';
    if (!signatureHeader) {
      this.logger.warn('回调缺少 Wechatpay-Signature 头');
      return { success: false, message: '缺少签名头' };
    }

    // Wechatpay-Signature 格式: WECHATPAY2-SHA256-RSA2048 timestamp="...",nonce_str="...",signature="..."
    const sigMatch = signatureHeader.match(/signature="([^"]+)"/);
    const timestampMatch = signatureHeader.match(/timestamp="([^"]+)"/);
    const nonceMatch = signatureHeader.match(/nonce_str="([^"]+)"/);

    if (!sigMatch || !timestampMatch || !nonceMatch) {
      this.logger.warn('回调签名头格式错误');
      return { success: false, message: '签名头格式错误' };
    }

    const sig = sigMatch[1];
    const sigTimestamp = timestampMatch[1];
    const sigNonce = nonceMatch[1];

    const verifyStr = `${sigTimestamp}\n${sigNonce}\n${rawBody}\n`;
    const publicKey = loadPublicKey();
    if (!verifySHA256RSA(verifyStr, sig, publicKey)) {
      this.logger.warn('回调签名验证失败');
      return { success: false, message: '签名验证失败' };
    }

    // 2. 解析回调正文
    const notifyData = JSON.parse(rawBody) as any;
    if (notifyData.event_type !== 'TRANSACTION.SUCCESS') {
      this.logger.log(`忽略非支付成功通知: ${notifyData.event_type}`);
      return { success: true, message: '忽略' };
    }

    // 3. AES-256-GCM 解密 resource
    const { nonce, ciphertext, associated_data } = notifyData.resource || {};
    if (!nonce || !ciphertext) {
      this.logger.warn('回调 resource 字段缺失');
      return { success: false, message: 'resource 字段缺失' };
    }

    const decrypted = decryptResource(nonce, ciphertext, associated_data || '', config.apiV3Key);
    const transaction = JSON.parse(decrypted) as any;

    const transactionId = transaction.transaction_id;
    const orderId = transaction.out_trade_no; // outTradeNo = orderId（uuid 去横线，创建时一致）

    this.logger.log(`支付成功回调: orderId=${orderId}, transactionId=${transactionId}`);

    // 4. 更新订单状态
    await db.update(orders).set({
      status: 'paid',
      transactionId,
      paidAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(orders.id, orderId));

    return { success: true, message: '成功' };
  }

  /**
   * 查询订单状态
   */
  async queryOrder(orderId: string) {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    return order || null;
  }
}
