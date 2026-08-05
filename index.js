const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const { init: initDB, Counter, Order } = require("./db");

try { require("dotenv").config(); } catch (_) {}

// ═══ BUILD MARKER v2026.08.04-1610 ═══
console.log("[INIT] index.js loaded — build marker v2026.08.04-1610");

const logger = morgan("tiny");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());
app.use(logger);

// ==================== access_token 缓存 ====================

const APPID = process.env.WECHAT_APPID || "";
const APPSECRET = process.env.WECHAT_APPSECRET || "";

let _accessToken = null;
let _tokenExpireAt = 0;

async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpireAt) return _accessToken;

  if (!APPID || !APPSECRET) throw new Error("WECHAT_APPID/APPSECRET 未配置");

  const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${APPSECRET}`;
  const tokenData = await new Promise((resolve, reject) => {
    https.get(tokenUrl, (resp) => {
      let d = "";
      resp.on("data", (c) => (d += c));
      resp.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });

  if (tokenData.errcode) throw new Error(`获取 access_token 失败: ${tokenData.errmsg}`);

  _accessToken = tokenData.access_token;
  _tokenExpireAt = Date.now() + (tokenData.expires_in - 300) * 1000; // 提前5分钟过期
  console.log("[CS] access_token 已刷新");
  return _accessToken;
}

// ==================== 路由 ====================

app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/count", async (req, res) => {
  const { action } = req.body;
  if (action === "inc") {
    await Counter.create();
  } else if (action === "clear") {
    await Counter.destroy({ truncate: true });
  }
  res.send({ code: 0, data: await Counter.count() });
});

app.get("/api/count", async (req, res) => {
  res.send({ code: 0, data: await Counter.count() });
});

/**
 * 云托管消息推送回调（仅用于配置检测，不自动下发链接）
 * POST /api/wechat-cs
 */
app.post("/api/wechat-cs", async (req, res) => {
  const body = req.body || {};
  console.log("[CS] 收到推送:", JSON.stringify(body).substring(0, 500));

  if (body.action === "CheckContainerPath") {
    console.log("[CS] 配置检测通过");
    return res.send("success");
  }

  console.log(`[CS] 收到推送: event=${body.Event}`);
  res.send("success");
});

/**
 * 客服消息下发
 * POST /api/wechat-cs/send
 *
 * 前端通过 callContainer 内网调用，注入 x-wx-openid。
 * 后端用 WECHAT_APPID/APPSECRET 拿 access_token 调微信客服消息 API。
 */
app.post("/api/wechat-cs/send", async (req, res) => {
  const { linkUrl } = req.body || {};
  const openId = req.headers["x-wx-openid"] || "";

  console.log(`[CS] send: openId=${openId || "(无)"}, linkUrl=${(linkUrl || "").substring(0, 80)}`);

  if (!openId) {
    return res.send({ code: 400, msg: "未获取到用户 openid（callContainer 未注入 x-wx-openid）", data: null });
  }
  if (!linkUrl) {
    return res.send({ code: 400, msg: "缺少 linkUrl 参数", data: null });
  }

  try {
    const token = await getAccessToken();
    const content = `点击下方链接即可在浏览器中打开：\n\n${linkUrl}`;
    const payload = JSON.stringify({ touser: openId, msgtype: "text", text: { content } });
    const apiUrl = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`;
    const parsed = new URL(apiUrl);

    await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      }, (resp) => {
        let d = "";
        resp.on("data", (c) => (d += c));
        resp.on("end", () => {
          try {
            const r = JSON.parse(d);
            if (r.errcode && r.errcode !== 0) {
              console.error("[CS] 微信API返回错误:", d);
              reject(new Error(r.errmsg || `errcode=${r.errcode}`));
            } else {
              console.log("[CS] 发送成功");
              resolve();
            }
          } catch (e) { reject(e); }
        });
      });
      req2.on("error", reject);
      req2.write(payload);
      req2.end();
    });

    return res.send({ code: 200, msg: "消息已发送", data: { openId } });
  } catch (err) {
    console.error("[CS] send 失败:", err.message || err);
    return res.send({ code: 500, msg: err.message || "发送失败", data: null });
  }
});

/** 调试 */
app.get("/api/wechat-cs/config-status", (req, res) => {
  const headerOpenId = req.headers["x-wx-openid"] || "";
  res.send({
    code: 200, msg: "ok",
    data: {
      openIdFromHeader: !!headerOpenId,
      appIdConfigured: !!APPID,
      appSecretConfigured: !!APPSECRET,
    },
  });
});

// ==================== 微信支付 ====================

const PAY_MCHID = process.env.WECHAT_PAY_MCHID || "";
const PAY_API_V3_KEY = process.env.WECHAT_PAY_API_V3_KEY || "";
const PAY_SERIAL_NO = process.env.WECHAT_PAY_SERIAL_NO || "";
const PAY_NOTIFY_URL = process.env.WECHAT_PAY_NOTIFY_URL || "";

// 私钥/公钥：优先读环境变量内容（云托管），fallback 读文件（本地开发）
let _privateKey = null;
let _publicKey = null;

function loadPrivateKey() {
  if (_privateKey) return _privateKey;
  const fromEnv = process.env.WECHAT_PAY_PRIVATE_KEY || "";
  if (fromEnv) {
    _privateKey = fromEnv.replace(/\\n/g, "\n"); // 环境变量中 \n 被转义
    return _privateKey;
  }
  const keyPath = process.env.WECHAT_PAY_PRIVATE_KEY_PATH || "./certs/apiclient_key.pem";
  if (!fs.existsSync(keyPath)) throw new Error("私钥未找到: " + keyPath + " — 请设置 WECHAT_PAY_PRIVATE_KEY 环境变量或确保文件存在");
  _privateKey = fs.readFileSync(keyPath, "utf8");
  return _privateKey;
}

function loadPublicKey() {
  if (_publicKey) return _publicKey;
  const fromEnv = process.env.WECHAT_PAY_PUBLIC_KEY || "";
  if (fromEnv) {
    _publicKey = fromEnv.replace(/\\n/g, "\n");
    return _publicKey;
  }
  const keyPath = process.env.WECHAT_PAY_PUBLIC_KEY_PATH || "./certs/wechatpay_public.pem";
  if (!fs.existsSync(keyPath)) throw new Error("公钥未找到: " + keyPath + " — 请设置 WECHAT_PAY_PUBLIC_KEY 环境变量或确保文件存在");
  _publicKey = fs.readFileSync(keyPath, "utf8");
  return _publicKey;
}

// 价目表（后端定价）
const PRODUCT_PRICES = {
  vip_count: { "vip-1": 1000, "vip-10": 8000, "vip-30": 18000 },
  vip_duration: { "vip-monthly": 9800, monthly: 0, yearly: 0 },
  scene_purchase: { "scene-2": 699, "scene-7": 699 },
};

const PRODUCT_NAMES = {
  vip_count: { "vip-1": "单次VIP权益体验包", "vip-10": "10次VIP权益优惠包", "vip-30": "30次VIP权益超值包" },
  vip_duration: { "vip-monthly": "连续包月VIP会员", monthly: "连续包月", yearly: "连续包年" },
  scene_purchase: { "scene-2": "场景体验", "scene-7": "场景体验" },
};

function getAmount(productType, productId) {
  const cat = PRODUCT_PRICES[productType];
  if (!cat) throw new Error("未知商品类型: " + productType);
  const amount = cat[productId];
  if (amount === undefined) throw new Error("未知商品: " + productType + "/" + productId);
  return amount;
}

function getDescription(productType, productId) {
  const cat = PRODUCT_NAMES[productType];
  return (cat && cat[productId]) || "创境XR服务";
}

// ========== 签名 & 加解密 ==========

function signSHA256RSA(data, privateKey) {
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(data);
  sign.end();
  return sign.sign(privateKey, "base64");
}

function verifySHA256RSA(data, signature, publicKey) {
  const verify = crypto.createVerify("RSA-SHA256");
  verify.update(data);
  verify.end();
  return verify.verify(publicKey, signature, "base64");
}

function buildAuthorization(method, urlPath, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex").substring(0, 32);
  const signStr = method + "\n" + urlPath + "\n" + timestamp + "\n" + nonce + "\n" + body + "\n";
  const signature = signSHA256RSA(signStr, loadPrivateKey());
  return 'WECHATPAY2-SHA256-RSA2048 mchid="' + PAY_MCHID + '",nonce_str="' + nonce + '",timestamp="' + timestamp + '",serial_no="' + PAY_SERIAL_NO + '",signature="' + signature + '"';
}

function decryptResource(nonce, ciphertext, associatedData) {
  const authTag = Buffer.from(ciphertext.slice(-32), "hex");
  const encryptedData = ciphertext.slice(0, -32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(PAY_API_V3_KEY), Buffer.from(nonce));
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(associatedData || ""));
  return Buffer.concat([decipher.update(Buffer.from(encryptedData, "hex")), decipher.final()]).toString("utf8");
}

function buildPrepaySign(prepayId) {
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(16).toString("hex").substring(0, 32);
  const packageStr = "prepay_id=" + prepayId;
  const signStr = APPID + "\n" + timeStamp + "\n" + nonceStr + "\n" + packageStr + "\n";
  const sign = signSHA256RSA(signStr, loadPrivateKey());
  return { prepayId, nonceStr, timeStamp, signType: "RSA", sign };
}

// ========== 支付路由 ==========

/**
 * 创建订单 + 微信 JSAPI 下单
 * POST /api/pay/order
 */
app.post("/api/pay/order", async (req, res) => {
  const openid = req.headers["x-wx-openid"] || "";
  const { productType, productId } = req.body || {};

  if (!openid) return res.send({ code: 401, msg: "未获取到用户 openid", data: null });
  if (!productType || !productId) return res.send({ code: 400, msg: "缺少参数", data: null });

  try {
    const amount = getAmount(productType, productId);
    if (amount === 0) return res.send({ code: 400, msg: "该商品暂不支持购买", data: null });

    const description = getDescription(productType, productId);
    const orderId = crypto.randomBytes(16).toString("hex"); // 32位 hex

    // 1. 写订单
    await Order.create({ id: orderId, openid, productType, productId, amount, status: "pending" });
    console.log("[PAY] 订单创建:", orderId, productType, productId, amount + "分");

    // 2. 调微信 JSAPI 下单
    const jsapiBody = JSON.stringify({
      appid: APPID,
      mchid: PAY_MCHID,
      description: description,
      out_trade_no: orderId,
      notify_url: PAY_NOTIFY_URL,
      amount: { total: amount, currency: "CNY" },
      payer: { openid: openid },
    });

    const urlPath = "/v3/pay/transactions/jsapi";
    const authHeader = buildAuthorization("POST", urlPath, jsapiBody);
    const parsed = new URL("https://api.mch.weixin.qq.com" + urlPath);

    const jsapiData = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": authHeader, "User-Agent": "chuangjingxr/1.0" },
      }, (resp) => {
        let d = "";
        resp.on("data", (c) => (d += c));
        resp.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      });
      r.on("error", reject);
      r.write(jsapiBody);
      r.end();
    });

    if (jsapiData.prepay_id) {
      // 3. 回存 prepay_id
      await Order.update({ prepayId: jsapiData.prepay_id }, { where: { id: orderId } });
      const prepayParams = buildPrepaySign(jsapiData.prepay_id);
      console.log("[PAY] JSAPI 下单成功, prepay_id:", jsapiData.prepay_id);
      return res.send({ code: 200, msg: "ok", data: { ...prepayParams, orderId } });
    }

    console.error("[PAY] JSAPI 下单失败:", JSON.stringify(jsapiData));
    await Order.update({ status: "cancelled" }, { where: { id: orderId } });
    throw new Error(jsapiData.message || "微信支付下单失败");
  } catch (err) {
    console.error("[PAY] createOrder 异常:", err.message);
    res.send({ code: 500, msg: err.message || "下单失败", data: null });
  }
});

/**
 * 微信支付回调通知
 * POST /api/pay/notify
 */
app.post("/api/pay/notify", async (req, res) => {
  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  console.log("[PAY] 回调:", rawBody.substring(0, 300));

  try {
    // 1. 验签
    const sigHeader = req.headers["wechatpay-signature"] || "";
    const sigMatch = sigHeader.match(/signature="([^"]+)"/);
    const tsMatch = sigHeader.match(/timestamp="([^"]+)"/);
    const nonceMatch = sigHeader.match(/nonce_str="([^"]+)"/);
    if (!sigMatch || !tsMatch || !nonceMatch) {
      return res.send({ code: "FAIL", message: "签名头格式错误" });
    }

    const verifyStr = tsMatch[1] + "\n" + nonceMatch[1] + "\n" + rawBody + "\n";
    if (!verifySHA256RSA(verifyStr, sigMatch[1], loadPublicKey())) {
      console.warn("[PAY] 签名验证失败");
      return res.send({ code: "FAIL", message: "签名验证失败" });
    }

    // 2. 解析通知
    const notifyData = JSON.parse(rawBody);
    if (notifyData.event_type !== "TRANSACTION.SUCCESS") {
      console.log("[PAY] 非支付成功通知:", notifyData.event_type);
      return res.send({ code: "SUCCESS", message: "忽略" });
    }

    // 3. AES-256-GCM 解密 resource
    const { nonce, ciphertext, associated_data } = notifyData.resource || {};
    if (!nonce || !ciphertext) return res.send({ code: "FAIL", message: "resource 字段缺失" });

    const decrypted = decryptResource(nonce, ciphertext, associated_data || "");
    const transaction = JSON.parse(decrypted);
    const orderId = transaction.out_trade_no;
    const transactionId = transaction.transaction_id;

    console.log("[PAY] 支付成功: orderId=" + orderId + ", txnId=" + transactionId);

    // 4. 更新订单
    await Order.update({ status: "paid", transactionId, paidAt: new Date() }, { where: { id: orderId } });

    res.send({ code: "SUCCESS", message: "成功" });
  } catch (err) {
    console.error("[PAY] notify 异常:", err.message);
    res.send({ code: "FAIL", message: err.message });
  }
});

/**
 * 查询订单状态
 * GET /api/pay/order/:id
 */
app.get("/api/pay/order/:id", async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.send({ code: 404, msg: "订单不存在", data: null });
  res.send({ code: 200, msg: "ok", data: order });
});

const port = process.env.PORT || 80;

async function bootstrap() {
  try { await initDB(); } catch (e) { console.warn("DB 初始化失败（不影响客服消息）:", e.message); }

  app.listen(port, () => {
    console.log("启动成功，端口:", port);
    console.log("微信客服下发: POST /api/wechat-cs/send");
    console.log("微信支付下单: POST /api/pay/order");
    console.log(`WECHAT_APPID: ${APPID ? "已配置" : "❌ 未配置"}`);
    console.log(`WECHAT_APPSECRET: ${APPSECRET ? "已配置" : "❌ 未配置"}`);
    console.log(`WECHAT_PAY_MCHID: ${PAY_MCHID ? "已配置" : "❌ 未配置"}`);
  });
}

bootstrap().catch(e => { console.error("启动失败:", e.message); process.exit(1); });
