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

/** 最简单的 https GET → JSON */
function httpsGetJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

/** 最简单的 https POST → JSON */
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
      res.on("end", () => {
        try { resolve(JSON.parse(resp)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** 获取微信 access_token */
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpireTime) return accessToken;

  if (!WECHAT_APPID || !WECHAT_APPSECRET) {
    throw new Error("微信配置不完整：WECHAT_APPID 或 WECHAT_APPSECRET 未设置");
  }

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WECHAT_APPID}&secret=${WECHAT_APPSECRET}`;
  const data = await httpsGetJSON(url);

  if (data.errcode) {
    console.error("获取 access_token 失败:", JSON.stringify(data));
    throw new Error(`获取 access_token 失败: ${data.errmsg}`);
  }

  accessToken = data.access_token;
  tokenExpireTime = Date.now() + (data.expires_in - 300) * 1000;
  console.log("access_token 获取成功");
  return accessToken;
}

/** 通过 login code 换取 openid */
async function code2Session(code) {
  if (!WECHAT_APPID || !WECHAT_APPSECRET) {
    throw new Error("微信配置不完整");
  }

  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${WECHAT_APPID}&secret=${WECHAT_APPSECRET}&js_code=${code}&grant_type=authorization_code`;
  const data = await httpsGetJSON(url);

  if (data.errcode) {
    console.error("code2session 失败:", JSON.stringify(data));
    throw new Error(`登录凭证校验失败: ${data.errmsg}`);
  }

  console.log(`code2session 成功，openid=${data.openid}`);
  return { openid: data.openid };
}

/** 发送客服文本消息（含外链） */
async function sendLinkMessage(openId, linkUrl) {
  const token = await getAccessToken();
  const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`;

  const content = `点击下方链接即可在浏览器中打开：\n\n${linkUrl}`;
  const body = { touser: openId, msgtype: "text", text: { content } };

  const data = await httpsPostJSON(url, body);

  if (data.errcode && data.errcode !== 0) {
    console.error("发送客服消息失败:", JSON.stringify(data));
    return false;
  }

  console.log(`客服消息已发送给用户 ${openId}，链接: ${linkUrl}`);
  return true;
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

// 获取计数
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
 * 通过小程序 login code 发送客服消息（前端 onClick 调用）
 * POST /api/wechat-cs/send-by-code
 * Body: { code: string, linkUrl: string }
 */
app.post("/api/wechat-cs/send-by-code", async (req, res) => {
  const { code, linkUrl } = req.body || {};
  if (!code) {
    return res.send({ code: 400, msg: "缺少 code 参数", data: null });
  }

  try {
    const session = await code2Session(code);
    const finalLink = linkUrl || "https://www.baidu.com";
    const success = await sendLinkMessage(session.openid, finalLink);

    if (success) {
      return res.send({ code: 200, msg: "消息已发送", data: { openid: session.openid } });
    }
    return res.send({ code: 500, msg: "消息发送失败", data: null });
  } catch (err) {
    console.error("sendByCode 异常:", err.message);
    return res.send({ code: 500, msg: err.message || "发送失败", data: null });
  }
});

/**
 * 获取配置状态（调试用）
 * GET /api/wechat-cs/config-status
 */
app.get("/api/wechat-cs/config-status", (req, res) => {
  res.send({
    code: 200,
    msg: "ok",
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
    console.log("微信客服消息 API: POST /api/wechat-cs/send-by-code");
    console.log("配置状态:", { appId: !!WECHAT_APPID, appSecret: !!WECHAT_APPSECRET });
  });
}

bootstrap();
