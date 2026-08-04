const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const cloudbase = require("@cloudbase/node-sdk");
const { init: initDB, Counter } = require("./db");

// 加载 .env（本地开发用），云托管通过平台注入环境变量
try { require("dotenv").config(); } catch (_) {}

// ═══ BUILD MARKER v2026.08.04-1530 ═══
console.log("[INIT] index.js loaded — build marker v2026.08.04-1530");

const logger = morgan("tiny");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());
app.use(logger);

// cloudbase SDK — 云托管环境自动获取凭据，无需手动配 APPID/APPSECRET
const tcb = cloudbase.init({ env: "prod-d3gj8bkj4f7f1cd19" });

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
 * 客服消息下发（内网 callContainer 调用）
 * POST /api/wechat-cs/send
 *
 * callContainer 自动注入 x-wx-openid header，无需传 code。
 * 用 cloudbase SDK openapi 发客服消息，凭据由云托管环境自动注入，
 * 无需 WECHAT_APPID / WECHAT_APPSECRET 环境变量。
 */
app.post("/api/wechat-cs/send", async (req, res) => {
  const { linkUrl } = req.body || {};

  // callContainer 内网注入的 openid
  const openId = req.headers["x-wx-openid"] || "";

  console.log(`[CS] send: x-wx-openid=${openId || "(无)"}, linkUrl=${(linkUrl || "").substring(0, 80)}`);

  if (!openId) {
    return res.send({ code: 400, msg: "未获取到用户 openid（callContainer 未注入 x-wx-openid）", data: null });
  }
  if (!linkUrl) {
    return res.send({ code: 400, msg: "缺少 linkUrl 参数", data: null });
  }

  try {
    const content = `点击下方链接即可在浏览器中打开：\n\n${linkUrl}`;
    const result = await tcb.openapi.customerServiceMessage.send({
      touser: openId,
      msgtype: "text",
      text: { content },
    });

    console.log("[CS] send 成功:", JSON.stringify(result).substring(0, 200));
    return res.send({ code: 200, msg: "消息已发送", data: { openId } });
  } catch (err) {
    console.error("[CS] send 失败:", err.message || err);
    return res.send({ code: 500, msg: err.message || "发送失败", data: null });
  }
});

/**
 * 兼容旧端点 send-by-code —— 转调 send
 * 不再需要 code、WECHAT_APPID/APPSECRET
 */
app.post("/api/wechat-cs/send-by-code", async (req, res) => {
  const { linkUrl } = req.body || {};
  const openId = req.headers["x-wx-openid"] || "";

  console.log(`[CS] send-by-code (legacy): x-wx-openid=${openId || "(无)"}`);

  if (!openId) {
    return res.send({ code: 400, msg: "未获取到用户 openid", data: null });
  }
  if (!linkUrl) {
    return res.send({ code: 400, msg: "缺少 linkUrl 参数", data: null });
  }

  try {
    const content = `点击下方链接即可在浏览器中打开：\n\n${linkUrl}`;
    await tcb.openapi.customerServiceMessage.send({
      touser: openId,
      msgtype: "text",
      text: { content },
    });
    return res.send({ code: 200, msg: "消息已发送", data: { openId } });
  } catch (err) {
    console.error("[CS] send-by-code 失败:", err.message || err);
    return res.send({ code: 500, msg: err.message || "发送失败", data: null });
  }
});

/** 调试：检查云托管环境状态 */
app.get("/api/wechat-cs/config-status", (req, res) => {
  const headerOpenId = req.headers["x-wx-openid"] || "";
  res.send({
    code: 200, msg: "ok",
    data: {
      openIdFromHeader: !!headerOpenId,
      tcbSdkReady: !!tcb,
      note: "使用 cloudbase SDK openapi，无需 WECHAT_APPID/APPSECRET 环境变量",
    },
  });
});

const port = process.env.PORT || 80;

async function bootstrap() {
  try { await initDB(); } catch (e) { console.warn("DB 初始化失败（不影响客服消息）:", e.message); }

  app.listen(port, () => {
    console.log("启动成功，端口:", port);
    console.log("微信客服下发: POST /api/wechat-cs/send (cloudbase SDK openapi)");
  });
}

bootstrap().catch(e => { console.error("启动失败:", e.message); process.exit(1); });
