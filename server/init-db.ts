import { ensureDatabase } from "./db";

await ensureDatabase();
console.log("MySQL 数据表已初始化。");
process.exit(0);
