import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const env = z.object({
  PORT: z.coerce.number().default(8787),
  MYSQL_URL: z.string().min(1, "MYSQL_URL is required"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  UPLOAD_DIR: z.string().default("./uploads"),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(10).optional(),
  ADMIN_NAME: z.string().min(1).default("系统管理员"),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_CHAT_MODEL: z.string().default("gpt-5.6"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_CHAT_MODEL: z.string().default("deepseek-v4-flash"),
}).parse(process.env);

export const config = { ...env, uploadDir: path.resolve(env.UPLOAD_DIR) };
