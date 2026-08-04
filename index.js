const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const https = require("https");
const crypto = require("crypto");
const { init: initDB, Counter } = require("./db");

// 加载 .env（本地开发用），云托管通过平台注入环境变量，dotenv 失败不影响运行
try { require("dotenv").config(); } catch (_) {}

const logger = morgan("tiny");

const app = express();
// 客服消息回调是 XML，不能用 json parser，用 raw body
app.use(express.text({ type: "text/xml" }));
app.use(express.raw({ type: "application/xml" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());
app.use(logger);

// ==================== 微信客服消息服务 ====================

const WECHAT_APPID = process.env.WECHAT_APPID || "";
const WECHAT_APPSECRET = process.env.WECHAT_APPSECRET || "";
const WECHAT_CS_TOKEN = process.env.WECHAT_CS_TOKEN || "";

let accessToken = null;
let tokenExpireTime = 0;

/** https GET → JSON */
function httpsGetJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

/** https POST → JSON */
function httpsPostJSON(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let resp = "";
      res.on("data", (chunk) => (resp += chunk));
      res.on("end", () => { try { resolve(JSON.parse(resp)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** 获取微信 access_token */
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpireTime) return accessToken;
  if (!WECHAT_APPID || !WECHAT_APPSECRET) throw new Error("微信配置不完整");
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WECHAT_APPID}&secret=${WECHAT_APPSECRET}`;
  const data = await httpsGetJSON(url);
  if (data.errcode) throw new Error(`获取 access_token 失败: ${data.errmsg}`);
  accessToken = data.access_token;
  tokenExpireTime = Date.now() + (data.expires_in - 300) * 1000;
  console.log("[CS] access_token 获取成功");
  return accessToken;
}

/** 通过 login code 换取 openid */
async function code2Session(code) {
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${WECHAT_APPID}&secret=${WECHAT_APPSECRET}&js_code=${code}&grant_type=authorization_code`;
  const data = await httpsGetJSON(url);
  if (data.errcode) throw new Error(`code2session 失败: ${data.errmsg}`);
  console.log(`[CS] code2session 成功 openid=${data.openid}`);
  return { openid: data.openid };
}

/** 发送客服文本消息（含外链） */
async function sendLinkMessage(openId, linkUrl) {
  const token = await getAccessToken();
  const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`;
  const content = `点击下方链接即可在浏览器中打开：\n\n${linkUrl}`;
  const data = await httpsPostJSON(url, { touser: openId, msgtype: "text", text: { content } });
  if (data.errcode && data.errcode !== 0) {
    console.error("[CS] 发送客服消息失败:", JSON.stringify(data));
    return false;
  }
  console.log(`[CS] 消息已发送给 ${openId}，链接: ${linkUrl}`);
  return true;
}

/** 解析 XML 中的 CDATA 或普通值 */
function extractXmlValue(xml, tag) {
  const m1 = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]></${tag}>`));
  if (m1) return m1[1];
  const m2 = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
  return m2 ? m2[1] : "";
}

/** 根据 sessionFrom 中的 action 构建外链 */
function buildLink(sessionFromStr) {
  let action = "experience";
  let sceneId = "1";
  let title = "";
  let xrType = "";
  try {
    const parsed = JSON.parse(sessionFromStr);
    action = parsed.action || action;
    sceneId = parsed.sceneId || sceneId;
    title = parsed.title || "";
    xrType = parsed.xrType || "";
  } catch (_) { /* ignore parse error */ }
  const baseUrl = action === "createSame"
    ? "https://www.bing.com"
    : "https://www.baidu.com";
  return `${baseUrl}?sceneId=${sceneId}&title=${encodeURIComponent(title)}&xrType=${encodeURIComponent(xrType)}&action=${action}`;
}

// ==================== 路由 ====================

// 首页
app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 更新计数
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

// 小程序调用，获取微信 Open ID
app.get("/api/wx_openid", async (req, res) => {
  if (req.headers["x-wx-source"]) {
    res.send(req.headers["x-wx-openid"]);
  }
});

/**
 * WeChat 服务器 URL 校验（GET 请求，用于首次配置）
 * GET /api/wechat-cs?signature=...&timestamp=...&nonce=...&echostr=...
 */
app.get("/api/wechat-cs", (req, res) => {
  const { signature, timestamp, nonce, echostr } = req.query;
  console.log(`[CS] URL 校验: signature=${signature}, timestamp=${timestamp}`);

  if (!WECHAT_CS_TOKEN) {
    console.warn("[CS] WECHAT_CS_TOKEN 未配置，URL 校验失败");
    return res.status(403).send("Forbidden: token not configured");
  }

  const arr = [WECHAT_CS_TOKEN, timestamp, nonce].sort();
  const sha1 = crypto.createHash("sha1").update(arr.join("")).digest("hex");
  if (sha1 === signature) {
    console.log("[CS] URL 校验通过");
    return res.send(echostr);
  }
  console.warn("[CS] URL 校验失败：签名不匹配");
  res.status(403).send("Forbidden: signature mismatch");
});

/**
 * WeChat 客服消息回调（POST 请求）
 * 用户进入客服会话或发送消息时，微信服务器推送 XML 到这里
 * POST /api/wechat-cs
 */
app.post("/api/wechat-cs", async (req, res) => {
  const xml = typeof req.body === "string" ? req.body : req.body?.toString() || "";
  console.log(`[CS] 收到回调: ${xml.substring(0, 300)}`);

  const fromUserName = extractXmlValue(xml, "FromUserName");
  const msgType = extractXmlValue(xml, "MsgType");
  const event = extractXmlValue(xml, "Event");
  const sessionFrom = extractXmlValue(xml, "SessionFrom");

  console.log(`[CS] 解析: from=${fromUserName}, msgType=${msgType}, event=${event}, sessionFrom=${sessionFrom}`);

  if (fromUserName) {
    // 用户进入会话事件 (user_enter_tempsession) 或发送消息时，自动下发链接
    if (msgType === "event" || (msgType === "text" && !sessionFrom)) {
      const link = buildLink(sessionFrom);
      this.sendLinkMessage(fromUserName, link)
        .then(ok => console.log(`[CS] 自动下发${ok ? "成功" : "失败"}: ${link}`))
        .catch(err => console.error(`[CS] 自动下发异常:`, err.message));
    }
  }

  // 返回 SUCCESS 给微信服务器
  res.set("Content-Type", "application/xml");
  res.send("<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>");
});

/**
 * 通过小程序 login code 发送客服消息（前端调用的主动下发接口）
 * POST /api/wechat-cs/send-by-code
 * Body: { code: string, linkUrl: string }
 */
app.post("/api/wechat-cs/send-by-code", async (req, res) => {
  const { code, linkUrl } = req.body || {};
  if (!code) return res.send({ code: 400, msg: "缺少 code 参数", data: null });

  try {
    const session = await code2Session(code);
    const finalLink = linkUrl || "https://www.baidu.com";
    const success = await sendLinkMessage(session.openid, finalLink);
    if (success) return res.send({ code: 200, msg: "消息已发送", data: { openid: session.openid } });
    return res.send({ code: 500, msg: "消息发送失败", data: null });
  } catch (err) {
    console.error("[CS] sendByCode 异常:", err.message);
    return res.send({ code: 500, msg: err.message || "发送失败", data: null });
  }
});

/**
 * 获取配置状态（调试用）
 * GET /api/wechat-cs/config-status
 */
app.get("/api/wechat-cs/config-status", (req, res) => {
  res.send({
    code: 200, msg: "ok",
    data: {
      appIdConfigured: !!WECHAT_APPID,
      appSecretConfigured: !!WECHAT_APPSECRET,
      tokenConfigured: !!WECHAT_CS_TOKEN,
    },
  });
});

const port = process.env.PORT || 80;

async function bootstrap() {
  await initDB();
  app.listen(port, () => {
    console.log("启动成功，端口:", port);
    console.log("微信客服回调: POST /api/wechat-cs");
    console.log("微信客服主动下发: POST /api/wechat-cs/send-by-code");
    console.log("配置:", { appId: !!WECHAT_APPID, appSecret: !!WECHAT_APPSECRET, token: !!WECHAT_CS_TOKEN });
  });
}

bootstrap();
