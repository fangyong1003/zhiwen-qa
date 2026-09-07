import fs from "node:fs/promises";
import { app } from "./app";
import { config } from "./config";
import { db, ensureDatabase } from "./db";

await fs.mkdir(config.uploadDir, { recursive: true });
await ensureDatabase();

const server = app.listen(config.PORT, () => console.log(`知问 API 已启动：http://localhost:${config.PORT}`));

function shutdown() {
  server.close(() => { void db.end(); });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
