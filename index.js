const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const https = require("https");
const { init: initDB, Counter } = require("./db");

// 加载 .env（本地开发用），云托管通过平台注入环境变量
try { require("dotenv").config(); } catch (_) {}

const logger = morgan("tiny");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());
app.use(logger);

// ==================== 微信云托管客服消息服务 ====================

/** 根据 sessionFrom 构建外链 */
function buildLink(sessionFromStr) {
  let action = "experience";
  let sceneId = "1";
  let title = "";
  let xrType = "";
  try {
    if (sessionFromStr) {
      const parsed = JSON.parse(sessionFromStr);
      action = parsed.action || action;
      sceneId = parsed.sceneId || sceneId;
      title = parsed.title || "";
      xrType = parsed.xrType || "";
    }
  } catch (_) { /* ignore */ }
  const baseUrl = action === "createSame"
    ? "https://www.bing.com"
    : "https://www.baidu.com";
  return `${baseUrl}?sceneId=${sceneId}&title=${encodeURIComponent(title)}&xrType=${encodeURIComponent(xrType)}&action=${action}`;
}

/**
 * 发送客服文本消息（含外链）
 * token 可以是普通 access_token 或 cloudbase_access_token
 */
async function sendLinkMessage(openId, linkUrl, token) {
  const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`;
  const content = `点击下方链接即可在浏览器中打开：\n\n${linkUrl}`;
  const body = JSON.stringify({ touser: openId, msgtype: "text", text: { content } });

  return new Promise((resolve) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          if (result.errcode && result.errcode !== 0) {
            console.error("[CS] 发送失败:", data);
            resolve(false);
          } else {
            console.log(`[CS] 消息已发送给 ${openId}，链接: ${linkUrl}`);
            resolve(true);
          }
        } catch (e) {
          console.error("[CS] 解析响应失败:", e.message);
          resolve(false);
        }
      });
    });
    req.on("error", (err) => {
      console.error("[CS] 请求失败:", err.message);
      resolve(false);
    });
    req.write(body);
    req.end();
  });
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

// 获取 OpenID
app.get("/api/wx_openid", async (req, res) => {
  if (req.headers["x-wx-source"]) {
    res.send(req.headers["x-wx-openid"]);
  }
});

/**
 * 云托管消息推送回调
 * POST /api/wechat-cs
 *
 * 云托管消息推送为 JSON 模式、内网免鉴权。
 * 用户进入客服会话时，微信推送 user_enter_tempsession 事件，
 * 请求头自动携带 x-wx-cloudbase-access-token（免鉴权调用微信 API 用）
 * 和 x-wx-openid（当前用户 OpenID）。
 */
app.post("/api/wechat-cs", async (req, res) => {
  const body = req.body || {};
  console.log("[CS] 收到推送:", JSON.stringify(body).substring(0, 500));

  // 云托管配置检测：返回 "success" 即可
  if (body.action === "CheckContainerPath") {
    console.log("[CS] 配置检测通过");
    return res.send("success");
  }

  // 消息推送仅用于云托管配置检测，不再自动下发链接
  // 外链下发由 onClick → send-by-code 负责，避免重复消息
  console.log(`[CS] 收到推送: event=${body.Event}`);

  // 必须返回 "success"
  res.send("success");
});

/**
 * 通过小程序 login code 发送客服消息（备用主动下发接口）
 * POST /api/wechat-cs/send-by-code
 */
app.post("/api/wechat-cs/send-by-code", async (req, res) => {
  const { code, linkUrl } = req.body || {};
  const appId = process.env.WECHAT_APPID || "";
  const appSecret = process.env.WECHAT_APPSECRET || "";

  if (!code) return res.send({ code: 400, msg: "缺少 code 参数", data: null });
  if (!appId || !appSecret) return res.send({ code: 500, msg: "WECHAT_APPID/APPSECRET 未配置", data: null });

  try {
    // code2session
    const sessionUrl = `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${appSecret}&js_code=${code}&grant_type=authorization_code`;
    const sessionData = await new Promise((resolve, reject) => {
      https.get(sessionUrl, (resp) => {
        let d = "";
        resp.on("data", (c) => (d += c));
        resp.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      }).on("error", reject);
    });

    if (sessionData.errcode) throw new Error(sessionData.errmsg);

    // 获取 access_token
    const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`;
    const tokenData = await new Promise((resolve, reject) => {
      https.get(tokenUrl, (resp) => {
        let d = "";
        resp.on("data", (c) => (d += c));
        resp.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      }).on("error", reject);
    });

    if (tokenData.errcode) throw new Error(tokenData.errmsg);

    // 发送客服消息（用普通 access_token，非云托管链路）
    const sendUrl = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${tokenData.access_token}`;
    const finalLink = linkUrl || "https://www.baidu.com";
    const content = `点击下方链接即可在浏览器中打开：\n\n${finalLink}`;
    const payload = JSON.stringify({ touser: sessionData.openid, msgtype: "text", text: { content } });

    const sendOk = await new Promise((resolve) => {
      const parsed = new URL(sendUrl);
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
            resolve(!r.errcode || r.errcode === 0);
          } catch { resolve(false); }
        });
      });
      req2.on("error", () => resolve(false));
      req2.write(payload);
      req2.end();
    });

    if (sendOk) return res.send({ code: 200, msg: "消息已发送", data: { openid: sessionData.openid } });
    return res.send({ code: 500, msg: "消息发送失败", data: null });
  } catch (err) {
    console.error("[CS] sendByCode 异常:", err.message);
    return res.send({ code: 500, msg: err.message || "发送失败", data: null });
  }
});

/** 获取配置状态 */
app.get("/api/wechat-cs/config-status", (req, res) => {
  res.send({
    code: 200, msg: "ok",
    data: {
      appIdConfigured: !!process.env.WECHAT_APPID,
      appSecretConfigured: !!process.env.WECHAT_APPSECRET,
    },
  });
});

const port = process.env.PORT || 80;

async function bootstrap() {
  await initDB();
  app.listen(port, () => {
    console.log("启动成功，端口:", port);
    console.log("云托管消息推送: POST /api/wechat-cs (JSON 模式)");
    console.log("备用接口: POST /api/wechat-cs/send-by-code");
  });
}

bootstrap();
