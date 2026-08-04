const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const https = require("https");
const { init: initDB, Counter } = require("./db");

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

const port = process.env.PORT || 80;

async function bootstrap() {
  try { await initDB(); } catch (e) { console.warn("DB 初始化失败（不影响客服消息）:", e.message); }

  app.listen(port, () => {
    console.log("启动成功，端口:", port);
    console.log("微信客服下发: POST /api/wechat-cs/send");
    console.log(`WECHAT_APPID: ${APPID ? "已配置" : "❌ 未配置"}`);
    console.log(`WECHAT_APPSECRET: ${APPSECRET ? "已配置" : "❌ 未配置"}`);
  });
}

bootstrap().catch(e => { console.error("启动失败:", e.message); process.exit(1); });
