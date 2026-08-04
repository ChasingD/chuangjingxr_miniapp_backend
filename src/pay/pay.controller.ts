// src/pay/pay.controller.ts
import { Controller, Post, Get, Req, Param, Logger } from '@nestjs/common';
import { Request } from 'express';
import { PayService } from './pay.service';

@Controller('pay')
export class PayController {
  private readonly logger = new Logger(PayController.name);

  constructor(private readonly payService: PayService) {}

  /**
   * 创建订单
   * POST /api/pay/order
   * Body: { productType, productId }
   * openid 从 x-wx-openid header 获取（callContainer 自动注入）
   */
  @Post('order')
  async createOrder(@Req() req: Request) {
    const openid = req.headers['x-wx-openid'] as string;
    if (!openid) {
      return { code: 401, msg: '未获取到用户 openid（callContainer 未注入 x-wx-openid）', data: null };
    }

    const { productType, productId } = req.body as any;
    if (!productType || !productId) {
      return { code: 400, msg: '缺少 productType 或 productId 参数', data: null };
    }

    try {
      const prepayParams = await this.payService.createOrder(openid, productType, productId);
      return { code: 200, msg: 'ok', data: prepayParams };
    } catch (err: any) {
      this.logger.error(`createOrder 异常: ${err.message}`);
      return { code: 500, msg: err.message || '下单失败', data: null };
    }
  }

  /**
   * 微信支付回调通知
   * POST /api/pay/notify
   */
  @Post('notify')
  async notify(@Req() req: Request) {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    this.logger.log(`支付回调: ${rawBody.substring(0, 200)}`);

    try {
      const result = await this.payService.handleNotify(
        (req.headers as unknown) as Record<string, string>,
        rawBody,
      );
      if (result.success) {
        return { code: 'SUCCESS', message: result.message };
      }
      return { code: 'FAIL', message: result.message };
    } catch (err: any) {
      this.logger.error(`notify 异常: ${err.message}`);
      return { code: 'FAIL', message: err.message };
    }
  }

  /**
   * 查询订单状态
   * GET /api/pay/order/:id
   */
  @Get('order/:id')
  async getOrder(@Param('id') id: string) {
    const order = await this.payService.queryOrder(id);
    if (!order) {
      return { code: 404, msg: '订单不存在', data: null };
    }
    return { code: 200, msg: 'ok', data: order };
  }
}
