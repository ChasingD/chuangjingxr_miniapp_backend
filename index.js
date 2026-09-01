const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const https = require("https");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const { init: initDB, Counter, Order, User } = require("./db");

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

// ==================== JWT & 微信服务 ====================

const JWT_SECRET = process.env.JWT_SECRET || "chuangjingxr-jwt-secret";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";

function generateToken(user) {
  return jwt.sign({ id: user.id, openid: user.openid, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function sanitizeUser(user) {
  return {
    id: user.id,
    openid: user.openid,
    phone: user.phone,
    nickname: user.nickname,
    avatar: user.avatar,
    role: user.role,
    createdAt: user.createdAt || null,
  };
}

/**
 * 微信 code → openid + session_key
 * @param {string} code - Taro.login() 返回的 code
 * @returns {{ openid: string, session_key: string }}
 */
async function jscode2session(code) {
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${APPID}&secret=${APPSECRET}&js_code=${code}&grant_type=authorization_code`;
  return new Promise((resolve, reject) => {
    https.get(url, (resp) => {
      let d = "";
      resp.on("data", (c) => (d += c));
      resp.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

/**
 * 微信 phoneCode → 真实手机号（需 access_token）
 * @param {string} phoneCode - getPhoneNumber 返回的 code
 * @returns {string} 纯手机号（不带区号）
 */
async function getPhoneNumber(phoneCode) {
  const token = await getAccessToken();
  const payload = JSON.stringify({ code: phoneCode });
  const apiUrl = `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${token}`;
  const parsed = new URL(apiUrl);

  return new Promise((resolve, reject) => {
    const req = https.request({
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
          if (r.errcode && r.errcode !== 0) reject(new Error(r.errmsg || `errcode=${r.errcode}`));
          else resolve(r.phone_info.purePhoneNumber);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
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

// ==================== 登录/注册 ====================

/** auth 中间件 — 后续需要鉴权的接口使用 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  if (!token) return res.send({ code: 401, msg: "未登录", data: null });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.send({ code: 401, msg: "登录已过期，请重新登录", data: null });
  }
}

/**
 * 同步用户信息到云托管
 * POST /api/user/sync
 *
 * 前端登录成功后调用，通过 callContainer 内网注入 x-wx-openid。
 * 用途：支付时后端用 openid 查 users 表获取联系方式写入 orders。
 */
app.post("/api/user/sync", async (req, res) => {
  const openid = req.headers["x-wx-openid"] || "";
  const { phone, nickname, avatar } = req.body || {};

  console.log(`[SYNC] openid=${openid ? openid.substring(0, 10) + "..." : "(无)"}, phone=${(phone || "").substring(0, 3)}****`);

  if (!openid) {
    return res.send({ code: 400, msg: "未获取到用户 openid", data: null });
  }

  try {
    let user = await User.findOne({ where: { openid } });

    if (user) {
      // 已存在 → 更新
      const updates = {};
      if (phone) updates.phone = phone;
      if (nickname) updates.nickname = nickname;
      if (avatar) updates.avatar = avatar;
      if (Object.keys(updates).length > 0) {
        await user.update(updates);
        console.log("[SYNC] 用户已更新: id=" + user.id);
      }
    } else {
      // 不存在 → 创建
      user = await User.create({
        openid,
        phone: phone || null,
        nickname: nickname || "微信用户",
        avatar: avatar || "",
      });
      console.log("[SYNC] 新用户创建: id=" + user.id);
    }

    res.send({ code: 200, msg: "ok", data: { userId: user.id } });
  } catch (err) {
    console.error("[SYNC] 异常:", err.message);
    res.send({ code: 500, msg: err.message || "同步失败", data: null });
  }
});

/**
 * 登录/注册
 * POST /api/xrAppletMobileLogin
 *
 * Body: { deviceKey, code, phonenumber, avatar?, nickName?, password? }
 * - 后端用 code → openid, phonenumber → 真实手机号
 * - 不传 password → 检测是否已注册：已注册返 { registered:true, token }；未注册返 { registered:false }
 * - 传 password → 注册新用户并登录
 */
app.post("/api/xrAppletMobileLogin", async (req, res) => {
  try {
    const { code, phonenumber, avatar, nickName, password } = req.body || {};

    if (!code) return res.send({ code: 400, msg: "缺少登录凭证 code", data: null });
    if (!phonenumber) return res.send({ code: 400, msg: "缺少手机号 phonenumber", data: null });

    // 1. code → openid
    const wxData = await jscode2session(code);
    const { openid, errcode, errmsg } = wxData;
    if (errcode) return res.send({ code: 500, msg: `微信登录失败: ${errmsg}`, data: null });
    console.log("[LOGIN] jscode2session 成功, openid:", (openid || "").substring(0, 10) + "...");

    // 2. phonenumber(phoneCode) → 真实手机号
    let phone = null;
    try {
      phone = await getPhoneNumber(phonenumber);
      console.log("[LOGIN] 手机号获取成功:", (phone || "").substring(0, 3) + "****");
    } catch (e) {
      console.warn("[LOGIN] 获取手机号失败:", e.message);
      return res.send({ code: 500, msg: "获取手机号失败，请重试", data: null });
    }

    // 3. 查找用户 — 先按手机号，再按 openid
    let user = null;
    let isNew = false;

    // 按手机号找
    if (phone) user = await User.findOne({ where: { phone } });

    // 按 openid 找（openid 和手机号不是同一人时，以手机号为准绑 openid）
    if (!user && openid) user = await User.findOne({ where: { openid } });

    if (!user) {
      // 未找到用户 → 判断是仅检测还是注册
      if (!password) {
        // 无密码 → 仅检测，返回未注册
        return res.send({ code: 200, msg: "ok", data: { registered: false, token: null, userId: null } });
      }

      // 有密码 → 新用户注册
      user = await User.create({
        openid,
        phone: phone || null,
        password, // TODO: 生产环境应 bcrypt 哈希
        nickname: nickName || "微信用户",
        avatar: avatar || "",
      });
      isNew = true;
      console.log("[LOGIN] 新用户注册: id=" + user.id + ", phone=" + (phone || "").substring(0, 3) + "****");
    } else {
      // 已有用户 → 更新信息
      let updated = false;

      // 手机号登录用户可能没有 openid，绑上
      if (openid && !user.openid) { user.openid = openid; updated = true; }

      // 头像/昵称首次或默认时更新
      if (avatar && (!user.avatar || user.avatar === "")) { user.avatar = avatar; updated = true; }
      if (nickName && (user.nickname === "微信用户" || !user.nickname)) { user.nickname = nickName; updated = true; }

      // 如果传了 password → 设置/更新密码
      if (password) { user.password = password; updated = true; }

      if (updated) await user.save();

      // 已有密码视为已注册
      if (!password && !user.password) {
        return res.send({ code: 200, msg: "ok", data: { registered: false, token: null, userId: null } });
      }

      console.log("[LOGIN] 已有用户登录: id=" + user.id);
    }

    // 4. 签发 token 并写入库
    const token = generateToken(user);
    user.token = token;
    await user.save();

    res.send({
      code: 200,
      msg: isNew ? "注册成功" : "登录成功",
      data: { registered: true, token, userId: user.id, user: sanitizeUser(user) },
    });
  } catch (err) {
    console.error("[LOGIN] 异常:", err.message);
    res.send({ code: 500, msg: "服务器异常", data: null });
  }
});

// ==================== 微信客服 ====================
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

  async function sendOnce() {
    const token = await getAccessToken();
    const content = "点击下方链接即可在浏览器中打开：\n\n" + linkUrl;
    const payload = JSON.stringify({ touser: openId, msgtype: "text", text: { content } });
    const apiUrl = "https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=" + token;
    const parsed = new URL(apiUrl);

    return new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      }, (resp) => {
        let d = "";
        resp.on("data", (c) => (d += c));
        resp.on("end", () => {
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      });
      req2.on("error", reject);
      req2.write(payload);
      req2.end();
    });
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    let lastResult = null;
    // openType="contact" 打开客服会话和本 API 是并行的——
    // 第一次进入时客服会话可能尚未建立完毕，微信 API 返回 45047。
    // 重试 2 次，间隔 1.5s 等会话就绪。
    for (let i = 0; i < 3; i++) {
      const result = await sendOnce();
      lastResult = result;
      if (!result.errcode || result.errcode === 0) {
        console.log("[CS] 发送成功" + (i > 0 ? "（第" + (i + 1) + "次尝试）" : ""));
        return res.send({ code: 200, msg: "消息已发送", data: { openId } });
      }
      console.warn("[CS] errcode=" + result.errcode + " " + (result.errmsg || "") + "，" + (i < 2 ? "1.5s 后重试..." : "已达最大重试次数"));
      if (i < 2) await sleep(1500);
    }
    console.error("[CS] 最终失败:", JSON.stringify(lastResult));
    return res.send({ code: 500, msg: lastResult.errmsg || "发送失败", data: null });
  } catch (err) {
    console.error("[CS] send 异常:", err.message || err);
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

// ==================== 用户信息 ====================

/**
 * phoneCode → 真实手机号
 * POST /api/wechat/exchange-phone
 * Body: { phoneCode } → { phoneNumber }
 */
app.post("/api/wechat/exchange-phone", async (req, res) => {
  const { phoneCode } = req.body || {};
  if (!phoneCode) return res.send({ code: 400, msg: "缺少 phoneCode", data: null });

  try {
    const phoneNumber = await getPhoneNumber(phoneCode);
    console.log("[PHONE] 兑换成功:", (phoneNumber || "").substring(0, 3) + "****");
    res.send({ code: 200, msg: "ok", data: { phoneNumber } });
  } catch (err) {
    console.error("[PHONE] 兑换失败:", err.message);
    res.send({ code: 500, msg: "获取手机号失败", data: null });
  }
});

/** 用微信 code 换 openid（无需登录） */
app.get("/api/openid", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send({ code: 400, msg: "code 参数必填", data: null });
  try {
    const result = await jscode2session(code);
    if (result.errcode) return res.send({ code: 400, msg: result.errmsg || "换取 openid 失败", data: null });
    res.send({ code: 200, msg: "ok", data: { openid: result.openid || "", session_key: result.session_key || "" } });
  } catch (err) {
    res.send({ code: 500, msg: err.message, data: null });
  }
});

/** 通过 callContainer 内网注入 x-wx-openid 直接取 openid（无需 code/无需登录） */
app.post("/api/openid", (req, res) => {
  const openid = req.headers["x-wx-openid"] || "";
  if (!openid) {
    return res.send({ code: 400, msg: "未获取到用户 openid（callContainer 未注入 x-wx-openid）", data: null });
  }
  res.send({ code: 200, msg: "ok", data: { openid } });
});

/** 获取当前用户信息（需登录） */
app.get("/api/user/info", authMiddleware, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.send({ code: 404, msg: "用户不存在", data: null });
    const data = sanitizeUser(user);
    // token 里的 openid 来自微信登录时的 x-wx-openid，比数据库更实时
    data.openid = req.user.openid || user.openid || '';
    res.send({ code: 200, msg: "ok", data });
  } catch (err) {
    res.send({ code: 500, msg: err.message, data: null });
  }
});

// ==================== 微信支付 ====================

const PAY_MCHID = process.env.WECHAT_PAY_MCHID || "";
const PAY_API_V3_KEY = process.env.WECHAT_PAY_API_V3_KEY || "";
const PAY_SERIAL_NO = process.env.WECHAT_PAY_SERIAL_NO || "";
const PAY_NOTIFY_URL = process.env.WECHAT_PAY_NOTIFY_URL || "";

// 私钥/公钥：优先读环境变量内容（云托管），fallback 读文件（本地开发）
let _privateKey = null;
let _publicKey = null;

/**
 * 归一化从环境变量读取的 PEM 密钥内容，兼容多种云托管录入方式：
 * - 录入时用 \n 替换换行 → replace 恢复
 * - 录入时粘贴多行（含真实换行）→ 直接用
 * - 录入时粘贴但平台删掉所有换行 → 按 PEM 标记重新插入换行
 */
function normalizePem(raw) {
  let s = raw.trim();
  // 已有真实换行 → 直接用
  if (s.includes("\n")) return s;
  // 含 \n 转义 → 替换为真实换行
  s = s.replace(/\\n/g, "\n");
  if (s.includes("\n")) return s;
  // 所有换行都被平台删掉了，按 PEM header/footer 重新格式化
  const headerMatch = s.match(/-----BEGIN [A-Z ]+-----/);
  const footerMatch = s.match(/-----END [A-Z ]+-----/);
  if (headerMatch && footerMatch) {
    const header = headerMatch[0];
    const footer = footerMatch[0];
    const body = s.slice(s.indexOf(header) + header.length, s.indexOf(footer));
    // 每 64 字符换行
    const lines = body.match(/.{1,64}/g) || [];
    return header + "\n" + lines.join("\n") + "\n" + footer + "\n";
  }
  // 无法识别，原样返回（后面 crypto 会报具体错误）
  return s;
}

function loadPrivateKey() {
  if (_privateKey) return _privateKey;
  const fromEnv = process.env.WECHAT_PAY_PRIVATE_KEY || "";
  if (fromEnv) {
    _privateKey = normalizePem(fromEnv);
    console.log("[PAY] 私钥来源: env, 长度:", _privateKey.length, "开头:", _privateKey.substring(0, 40));
    return _privateKey;
  }
  const keyPath = process.env.WECHAT_PAY_PRIVATE_KEY_PATH || "./certs/apiclient_key.pem";
  if (!fs.existsSync(keyPath)) throw new Error("私钥未找到: " + keyPath + " — 请设置 WECHAT_PAY_PRIVATE_KEY 环境变量或确保文件存在");
  _privateKey = fs.readFileSync(keyPath, "utf8");
  console.log("[PAY] 私钥来源: file", keyPath, "长度:", _privateKey.length);
  return _privateKey;
}

function loadPublicKey() {
  if (_publicKey) return _publicKey;
  const fromEnv = process.env.WECHAT_PAY_PUBLIC_KEY || "";
  if (fromEnv) {
    _publicKey = normalizePem(fromEnv);
    console.log("[PAY] 公钥来源: env, 长度:", _publicKey.length, "开头:", _publicKey.substring(0, 40));
    return _publicKey;
  }
  const keyPath = process.env.WECHAT_PAY_PUBLIC_KEY_PATH || "./certs/wechatpay_public.pem";
  if (!fs.existsSync(keyPath)) throw new Error("公钥未找到: " + keyPath + " — 请设置 WECHAT_PAY_PUBLIC_KEY 环境变量或确保文件存在");
  _publicKey = fs.readFileSync(keyPath, "utf8");
  console.log("[PAY] 公钥来源: file", keyPath, "长度:", _publicKey.length);
  return _publicKey;
}

// 价目表（后端定价）
const PRODUCT_PRICES = {
  vip_count: { "vip-1": 1000, "vip-10": 8000, "vip-30": 18000 },
  vip_regular: { monthly: 1000, quarter: 2700, yearly: 9800 },
  vip_duration: { "vip-monthly": 9800, "vip-quarterly": 27000, "vip-yearly": 105800 },
  scene_purchase: { "scene-2": 699, "scene-7": 699 },
};

const PRODUCT_NAMES = {
  vip_count: { "vip-1": "单次VIP权益体验包", "vip-10": "10次VIP权益优惠包", "vip-30": "30次VIP权益超值包" },
  vip_regular: { monthly: "连续包月", quarter: "连续包季", yearly: "连续包年" },
  vip_duration: { "vip-monthly": "连续包月VIP会员", "vip-quarterly": "连续包季VIP会员", "vip-yearly": "连续包年VIP会员" },
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

/**
 * 主动查单 — 调微信查单 API（GET /v3/pay/transactions/out-trade-no/{outTradeNo}）
 * 用于不开公网回调的场景，以查单代替被动通知
 */
async function queryWechatOrder(outTradeNo) {
  const urlPath = "/v3/pay/transactions/out-trade-no/" + outTradeNo + "?mchid=" + PAY_MCHID;
  const body = "";
  const authHeader = buildAuthorization("GET", urlPath, body);
  const parsed = new URL("https://api.mch.weixin.qq.com" + urlPath);

  return new Promise((resolve, reject) => {
    https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { "Accept": "application/json", "Authorization": authHeader, "User-Agent": "chuangjingxr/1.0" },
    }, (resp) => {
      let d = "";
      resp.on("data", (c) => (d += c));
      resp.on("end", () => {
        try {
          const data = JSON.parse(d);
          if (data.trade_state === "SUCCESS") {
            resolve({ paid: true, transactionId: data.transaction_id || "", tradeState: "SUCCESS" });
          } else if (data.code) {
            // API 错误（订单不存在等）
            reject(new Error(data.message || "查单失败"));
          } else {
            // 未支付
            resolve({ paid: false, transactionId: "", tradeState: data.trade_state || "UNKNOWN" });
          }
        } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

// ========== 支付路由 ==========

/**
 * 创建订单 + 微信 JSAPI 下单
 * POST /api/pay/order
 */
app.post("/api/pay/order", async (req, res) => {
  const openid = req.headers["x-wx-openid"] || "";
  const { productType, productId, merOrderId, amount: reqAmount } = req.body || {};

  if (!openid) return res.send({ code: 401, msg: "未获取到用户 openid", data: null });
  if (!productType || !productId) return res.send({ code: 400, msg: "缺少参数", data: null });

  try {
    // 金额：前端传了就用前端的（来自价格接口），没传则用后端固定定价
    const amount = (reqAmount != null && Number.isFinite(reqAmount) && reqAmount > 0)
      ? reqAmount
      : getAmount(productType, productId);
    if (amount <= 0) return res.send({ code: 400, msg: "该商品暂不支持购买", data: null });

    const description = getDescription(productType, productId);
    // 使用自有后台的 merOrderId，未传则自动生成
    // 坑：serverback 续费返回的 newMerOrderId 可能固定复用（同一未支付续费单），再次下单会主键冲突
    // → 冲突时自生成新订单号继续（微信支付用新号；回调 serverback 仍用 serverback 订单号，两者解耦）
    let orderId = merOrderId || crypto.randomBytes(16).toString("hex");

    // 0. 查/建用户信息（用于客服售后联系；兜底：即使 sync 未完成也能建立映射）
    let userId = null, userPhone = null, userNickname = null;
    try {
      const [user] = await User.findOrCreate({
        where: { openid },
        defaults: { nickname: "微信用户", avatar: "" },
      });
      userId = user.id;
      userPhone = user.phone;
      userNickname = user.nickname;
    } catch (e) {
      console.warn("[PAY] 查用户信息失败（不影响下单）:", e.message);
    }

    // 1. 写订单
    const createOrderRecord = (oid) => Order.create({
      id: oid,
      openid,
      productType,
      productId,
      amount,
      status: "pending",
      userId,
      phone: userPhone,
      nickname: userNickname,
    });
    try {
      await createOrderRecord(orderId);
    } catch (err) {
      if (err.name === "SequelizeUniqueConstraintError" || /ER_DUP_ENTRY/i.test(err.message)) {
        console.warn("[PAY] 订单号冲突（serverback 返回重复 merOrderId）:", orderId, "→ 自生成新订单号");
        orderId = crypto.randomBytes(16).toString("hex");
        await createOrderRecord(orderId);
      } else {
        throw err;
      }
    }
    console.log("[PAY] 订单创建:", orderId, productType, productId, amount + "分",
      merOrderId ? "(外部订单)" : "(内部订单)",
      userId ? "userId=" + userId : "(用户信息缺失)");

    // 2. 调微信 JSAPI 下单
    const jsapiBody = JSON.stringify({
      appid: APPID,
      mchid: PAY_MCHID,
      description: description,
      out_trade_no: orderId,
      notify_url: PAY_NOTIFY_URL || "https://noop.placeholder/pay/notify", // 不开公网则占位，以查单为主
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
 * 查询订单状态（不开公网时以此代回调）
 * GET /api/pay/order/:id
 * pending 订单会主动调微信查单 API 确认支付状态
 */
app.get("/api/pay/order/:id", async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.send({ code: 404, msg: "订单不存在", data: null });

  // pending 订单 → 主动查微信确认是否已支付
  if (order.status === "pending") {
    try {
      const wxResult = await queryWechatOrder(order.id);
      if (wxResult.paid) {
        await Order.update(
          { status: "paid", transactionId: wxResult.transactionId, paidAt: new Date() },
          { where: { id: order.id } }
        );
        order.status = "paid";
        order.transactionId = wxResult.transactionId;
        console.log("[PAY] 查单确认已支付:", order.id, wxResult.transactionId);
      }
    } catch (e) {
      // 查单失败不影响返回，仍返回当前订单状态
      console.warn("[PAY] 查单失败:", e.message);
    }
  }

  res.send({ code: 200, msg: "ok", data: order });
});

// ==================== 小程序虚拟支付（米大师） ====================
// 官方能力: https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html
// 前提: MP 后台开通虚拟支付 → offerId + AppKey（现网/沙箱）+ 虚拟支付专用二级商户号
// 前端: Taro.login() code → /api/virtual-pay/pre-create → wx.requestVirtualPayment → /api/virtual-pay/deliver

const VIRTUAL_PAY_OFFER_ID = process.env.VIRTUAL_PAY_OFFER_ID || "";
const VIRTUAL_PAY_APP_KEY = process.env.VIRTUAL_PAY_APP_KEY || "";
const VIRTUAL_PAY_APP_KEY_SANDBOX = process.env.VIRTUAL_PAY_APP_KEY_SANDBOX || "";

function hmacSha256Hex(key, data) {
  return crypto.createHmac("sha256", String(key)).update(data, "utf8").digest("hex");
}

/** 模板固定价位道具: 金额(分) → 道具 productId（商户后台需按实际价格档配置同名同价道具） */
function templateVirtualProductId(amountFen) {
  return "scene_" + amountFen;
}

/** 虚拟支付道具 id 只允许 [A-Za-z0-9_]，会员 productId 中横线转下划线（vip-1 → vip_1，vip-monthly → vip_monthly） */
function membershipVirtualProductId(productId) {
  return String(productId).replace(/-/g, "_");
}

/** outTradeNo: 8-32 位，仅 [A-Za-z0-9_\-|*@]；每次支付独立随机（米大师单号一次性，复用会报 -15012 关单） */
function buildOutTradeNo() {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * 虚拟支付预下单（签名直购）
 * POST /api/virtual-pay/pre-create
 * Body: { code, productType, productId, merOrderId?, amountYuan?, env? }
 * 流程: wx.login code → code2Session 拿 session_key → 组 signData → paySig(APP_KEY)/signature(session_key)
 * 返回: { mode, offerId, env, paySig, signData, signature, outTradeNo }  → 直喂 wx.requestVirtualPayment
 */
app.post("/api/virtual-pay/pre-create", async (req, res) => {
  const { code, productType, productId, merOrderId, amountYuan, env = 0 } = req.body || {};
  if (!code) return res.send({ code: 400, msg: "缺少 wx.login code", data: null });
  if (!productType || !productId) return res.send({ code: 400, msg: "缺少商品参数", data: null });

  const sandbox = Number(env) === 1;

  try {
    // 1. 金额: 会员走后端固定价；模板按前端实价（价格接口），兜底拒绝 0/负价
    let goodsPrice;
    if (productType === "scene_purchase") {
      goodsPrice = Math.round((Number(amountYuan) || 0) * 100);
      if (!Number.isFinite(goodsPrice) || goodsPrice <= 0) {
        return res.send({ code: 400, msg: "该商品暂不支持购买", data: null });
      }
    } else {
      goodsPrice = getAmount(productType, productId);
    }

    // 2. 虚拟支付道具 id: 模板用固定价位道具（scene_分），会员把横线转下划线（道具 id 只允许 [A-Za-z0-9_]）
    const vpProductId = productType === "scene_purchase"
      ? templateVirtualProductId(goodsPrice)
      : membershipVirtualProductId(productId);
    const vpOfferId = VIRTUAL_PAY_OFFER_ID;
    if (!vpOfferId) return res.send({ code: 500, msg: "虚拟支付未配置 offerId（环境变量 VIRTUAL_PAY_OFFER_ID）", data: null });

    const appKey = sandbox ? (VIRTUAL_PAY_APP_KEY_SANDBOX || VIRTUAL_PAY_APP_KEY) : VIRTUAL_PAY_APP_KEY;
    if (!appKey) return res.send({ code: 500, msg: "虚拟支付未配置 AppKey（环境变量 VIRTUAL_PAY_APP_KEY）", data: null });

    // 3. code → session_key（单次有效）
    const wxData = await jscode2session(code);
    if (wxData.errcode) {
      return res.send({ code: 500, msg: "微信登录失败: " + (wxData.errmsg || wxData.errcode), data: null });
    }
    const sessionKey = wxData.session_key;
    if (!sessionKey) return res.send({ code: 500, msg: "未获取到 session_key", data: null });

    // 4. outTradeNo: 每次支付独立随机（米大师单号一次性，失败关单后复用同一单号会报 -15012 请换新单号重试）
    //    serverback merOrderId 仅作业务关联：支付成功后前端调 serverback 回调激活会员，body 显式传 merOrderId，
    //    与米大师 outTradeNo 完全解耦，故不复用 merOrderId 作 outTradeNo
    const outTradeNo = buildOutTradeNo();

    // 5. 组装 signData（字段勿多勿少；多传会被微信拒）
    const signData = JSON.stringify({
      offerId: vpOfferId,
      buyQuantity: 1,
      env: sandbox ? 1 : 0,
      currencyType: "CNY",
      productId: vpProductId,
      goodsPrice,
      outTradeNo,
    });

    // 双签名: paySig = HMAC-SHA256(AppKey, "requestVirtualPayment&" + signData)；signature = HMAC-SHA256(session_key, signData)
    const paySig = hmacSha256Hex(appKey, "requestVirtualPayment&" + signData);
    const signature = hmacSha256Hex(sessionKey, signData);

    console.log("[VP] 预下单: outTradeNo=" + outTradeNo, productType, vpProductId, goodsPrice + "分", "env=" + (sandbox ? "沙箱" : "现网"), merOrderId ? "merOrderId=" + merOrderId : "");
    return res.send({
      code: 200, msg: "ok",
      data: { mode: "short_series_goods", offerId: vpOfferId, env: sandbox ? 1 : 0, paySig, signData, signature, outTradeNo },
    });
  } catch (err) {
    console.error("[VP] pre-create 异常:", err.message);
    return res.send({ code: 500, msg: err.message || "虚拟支付下单失败", data: null });
  }
});

/**
 * 虚拟支付发货确认
 * POST /api/virtual-pay/deliver
 * Body: { orderId, env? }
 * 调 xpay/notify_provide_goods 标记已发货（15 天不发货自动退款，必须确认）
 */
app.post("/api/virtual-pay/deliver", async (req, res) => {
  const { orderId, env = 0 } = req.body || {};
  if (!orderId) return res.send({ code: 400, msg: "缺少 orderId", data: null });
  try {
    const token = await getAccessToken();
    const payload = JSON.stringify({ order_id: String(orderId), env: Number(env) });
    const parsed = new URL("https://api.weixin.qq.com/xpay/notify_provide_goods?access_token=" + token);
    const r = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      }, (resp) => {
        let d = "";
        resp.on("data", (c) => (d += c));
        resp.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      });
      req2.on("error", reject);
      req2.write(payload);
      req2.end();
    });
    if (r.errcode && r.errcode !== 0) {
      console.error("[VP] 发货确认失败:", JSON.stringify(r));
      return res.send({ code: 500, msg: r.errmsg || "发货确认失败", data: null });
    }
    console.log("[VP] 发货确认成功: orderId=" + orderId, "env=" + Number(env));
    return res.send({ code: 200, msg: "ok", data: null });
  } catch (err) {
    console.error("[VP] deliver 异常:", err.message);
    return res.send({ code: 500, msg: err.message || "发货确认失败", data: null });
  }
});

/**
 * 虚拟支付退款（沙箱测试款退还）
 * POST /api/virtual-pay/refund
 * Body: { code, orderId, refundFee, refundReason?, env? }
 * 流程: wx.login code → code2Session 拿 openid（同一用户，可退该用户历史单）→ 组 refund body → pay_sig → xpay/refund_order
 * 注意: 接口只「启动退款任务」，最终状态需 query_order 确认；此处全额退（left_fee=refund_fee=refundFee）
 */
app.post("/api/virtual-pay/refund", async (req, res) => {
  const { code, orderId, refundFee, refundReason, env = 0 } = req.body || {};
  if (!code) return res.send({ code: 400, msg: "缺少 wx.login code", data: null });
  if (!orderId) return res.send({ code: 400, msg: "缺少 orderId", data: null });
  const sandbox = Number(env) === 1;
  const fee = Number(refundFee);
  if (!Number.isFinite(fee) || fee <= 0) return res.send({ code: 400, msg: "退款金额无效", data: null });

  const appKey = sandbox ? (VIRTUAL_PAY_APP_KEY_SANDBOX || VIRTUAL_PAY_APP_KEY) : VIRTUAL_PAY_APP_KEY;
  if (!appKey) return res.send({ code: 500, msg: "虚拟支付未配置 AppKey", data: null });

  try {
    const token = await getAccessToken();
    const wxData = await jscode2session(code);
    if (wxData.errcode) {
      return res.send({ code: 500, msg: "微信登录失败: " + (wxData.errmsg || wxData.errcode), data: null });
    }
    const openid = wxData.openid;
    if (!openid) return res.send({ code: 500, msg: "未获取到 openid", data: null });

    const refundOrderId = crypto.randomBytes(8).toString("hex"); // 退款单号（自定义，随机）
    const body = JSON.stringify({
      openid,
      order_id: String(orderId),
      refund_order_id: refundOrderId,
      left_fee: fee,           // 全额退：剩余可退 = 本次退
      refund_fee: fee,
      refund_reason: Number(refundReason) || 3, // 3=用户主动退款
      env: sandbox ? 1 : 0,
    });
    const path = "/xpay/refund_order";
    const paySig = hmacSha256Hex(appKey, path + "&" + body);
    const parsed = new URL("https://api.weixin.qq.com" + path + "?access_token=" + token + "&pay_sig=" + paySig);
    const r = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, (resp) => {
        let d = "";
        resp.on("data", (c) => (d += c));
        resp.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      });
      req2.on("error", reject);
      req2.write(body);
      req2.end();
    });
    console.log("[VP] 退款发起: orderId=" + orderId, "refund_order_id=" + refundOrderId, fee + "分", "env=" + (sandbox ? "沙箱" : "现网"), JSON.stringify(r));
    if (r.errcode && r.errcode !== 0) {
      return res.send({ code: 500, msg: r.errmsg || "退款发起失败", data: r });
    }
    return res.send({ code: 200, msg: "ok", data: { refundOrderId, ...r } });
  } catch (err) {
    console.error("[VP] refund 异常:", err.message);
    return res.send({ code: 500, msg: err.message || "退款发起失败", data: null });
  }
});

/**
 * 虚拟支付道具查询（调试用）
 * GET /api/virtual-pay/query-goods?env=1
 * 调 xpay/query_goods 拉 offerId 下道具列表，核对 offerId/道具/发布状态/价格
 */
app.get("/api/virtual-pay/query-goods", async (req, res) => {
  const env = Number(req.query.env != null ? req.query.env : 1);
  if (!VIRTUAL_PAY_OFFER_ID) return res.send({ code: 500, msg: "未配置 VIRTUAL_PAY_OFFER_ID", data: null });
  // pay_sig = HMAC-SHA256(AppKey, 路径 + "&" + 请求体)；AppKey 与环境匹配（沙箱用沙箱 key）
  const appKey = env === 1 ? (VIRTUAL_PAY_APP_KEY_SANDBOX || VIRTUAL_PAY_APP_KEY) : VIRTUAL_PAY_APP_KEY;
  if (!appKey) return res.send({ code: 500, msg: "未配置 AppKey", data: null });
  try {
    const token = await getAccessToken();
    const body = JSON.stringify({ env });
    const path = "/xpay/query_publish_goods";
    const paySig = hmacSha256Hex(appKey, path + "&" + body);
    const parsed = new URL("https://api.weixin.qq.com" + path + "?access_token=" + token + "&pay_sig=" + paySig);
    const r = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, (resp) => {
        let d = "";
        resp.on("data", (c) => (d += c));
        resp.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      });
      req2.on("error", reject);
      req2.write(body);
      req2.end();
    });
    console.log("[VP] query_publish_goods env=" + env, JSON.stringify(r));
    if (r.errcode && r.errcode !== 0) {
      return res.send({ code: 500, msg: r.errmsg || "查询道具失败", data: r });
    }
    return res.send({ code: 200, msg: "ok", data: r });
  } catch (err) {
    console.error("[VP] query_goods 异常:", err.message);
    return res.send({ code: 500, msg: err.message || "查询道具失败", data: null });
  }
});

const port = process.env.PORT || 80;

async function bootstrap() {
  try { await initDB(); } catch (e) { console.warn("DB 初始化失败（不影响客服消息）:", e.message); }

  app.listen(port, () => {
    console.log("启动成功，端口:", port);
    console.log("登录注册: POST /api/xrAppletMobileLogin");
    console.log("用户信息: GET /api/user/info");
    console.log("微信客服下发: POST /api/wechat-cs/send");
    console.log("微信支付下单: POST /api/pay/order");
    console.log("虚拟支付预下单: POST /api/virtual-pay/pre-create");
    console.log("虚拟支付道具查询: GET /api/virtual-pay/query-goods?env=1");
    console.log("虚拟支付发货: POST /api/virtual-pay/deliver");
    console.log("虚拟支付退款: POST /api/virtual-pay/refund");
    console.log(`WECHAT_APPID: ${APPID ? "已配置" : "❌ 未配置"}`);
    console.log(`WECHAT_APPSECRET: ${APPSECRET ? "已配置" : "❌ 未配置"}`);
    console.log(`WECHAT_PAY_MCHID: ${PAY_MCHID ? "已配置" : "❌ 未配置"}`);
    console.log(`VIRTUAL_PAY_OFFER_ID: ${VIRTUAL_PAY_OFFER_ID ? "已配置" : "❌ 未配置"}`);
    console.log(`VIRTUAL_PAY_APP_KEY: ${VIRTUAL_PAY_APP_KEY ? "已配置" : "❌ 未配置"}`);
    console.log(`VIRTUAL_PAY_APP_KEY_SANDBOX: ${VIRTUAL_PAY_APP_KEY_SANDBOX ? "已配置" : "❌ 未配置"}`);
  });
}

bootstrap().catch(e => { console.error("启动失败:", e.message); process.exit(1); });
