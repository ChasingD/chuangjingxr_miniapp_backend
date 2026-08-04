import { pgTable, varchar, integer, timestamp } from 'drizzle-orm/pg-core';

export const orders = pgTable('orders', {
  id: varchar('id', { length: 36 }).primaryKey(),
  openid: varchar('openid', { length: 64 }).notNull(),
  productType: varchar('product_type', { length: 20 }).notNull(),
  productId: varchar('product_id', { length: 36 }).notNull(),
  amount: integer('amount').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  prepayId: varchar('prepay_id', { length: 64 }),
  transactionId: varchar('transaction_id', { length: 64 }),
  paidAt: timestamp('paid_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
