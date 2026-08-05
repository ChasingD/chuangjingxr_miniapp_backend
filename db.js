const { Sequelize, DataTypes } = require("sequelize");

// 从环境变量中读取数据库配置
const { MYSQL_USERNAME, MYSQL_PASSWORD, MYSQL_ADDRESS = "" } = process.env;

const [host, port] = MYSQL_ADDRESS.split(":");

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
  paidAt: { type: DataTypes.DATE, field: "paid_at" },
}, {
  tableName: "orders",
  underscored: true,
});

// 数据库初始化方法
async function init() {
  await Counter.sync({ alter: true });
  await Order.sync({ alter: true });
}

// 导出初始化方法和模型
module.exports = {
  init,
  Counter,
  Order,
};
