const { Sequelize, DataTypes } = require("sequelize");

// 从环境变量中读取数据库配置（云托管自动注入，本地开发在 .env 中配置）
const { MYSQL_USERNAME = "", MYSQL_PASSWORD = "", MYSQL_ADDRESS = "" } = process.env;

if (!MYSQL_ADDRESS || !MYSQL_USERNAME) {
  console.error("[DB] MYSQL_ADDRESS/MYSQL_USERNAME 未配置！");
  console.error("[DB] 云托管：请在控制台关联 MySQL 数据库");
  console.error("[DB] 本地开发：在 .env 中配置 MYSQL_ADDRESS=host:port");
}

const [host, port = "3306"] = MYSQL_ADDRESS.split(":");

console.log(`[DB] 连接 MySQL: ${MYSQL_USERNAME}@${host}:${port}`);

const sequelize = new Sequelize("nodejs_demo", MYSQL_USERNAME, MYSQL_PASSWORD, {
  host,
  port,
  dialect: "mysql" /* one of 'mysql' | 'mariadb' | 'postgres' | 'mssql' */,
});

// 定义数据模型
const Counter = sequelize.define("Counter", {
  count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
});

const Order = sequelize.define("Order", {
  id: { type: DataTypes.STRING(32), primaryKey: true },
  openid: { type: DataTypes.STRING(64), allowNull: false },
  productType: { type: DataTypes.STRING(20), allowNull: false, field: "product_type" },
  productId: { type: DataTypes.STRING(36), allowNull: false, field: "product_id" },
  amount: { type: DataTypes.INTEGER, allowNull: false },
  status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "pending" },
  prepayId: { type: DataTypes.STRING(64), field: "prepay_id" },
  transactionId: { type: DataTypes.STRING(64), field: "transaction_id" },
  userId: { type: DataTypes.INTEGER, field: "user_id" },
  phone: { type: DataTypes.STRING(20) },
  nickname: { type: DataTypes.STRING(64) },
  paidAt: { type: DataTypes.DATE, field: "paid_at" },
}, {
  tableName: "orders",
  underscored: true,
});

// 用户模型
const User = sequelize.define("User", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  openid: { type: DataTypes.STRING(64), allowNull: true, unique: true },
  phone: { type: DataTypes.STRING(20), allowNull: true, unique: true },
  password: { type: DataTypes.STRING(128), allowNull: true },
  nickname: { type: DataTypes.STRING(64), defaultValue: "微信用户" },
  avatar: { type: DataTypes.STRING(512), defaultValue: "" },
  token: { type: DataTypes.STRING(256), allowNull: true },
  role: { type: DataTypes.STRING(16), defaultValue: "user" },
}, {
  tableName: "users",
  underscored: true,
});

// 数据库初始化方法
async function init() {
  await Counter.sync({ alter: true });
  await Order.sync({ alter: true });
  await User.sync({ alter: true });
}

// 导出初始化方法和模型
module.exports = {
  init,
  Counter,
  Order,
  User,
};
