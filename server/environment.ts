import { z } from "zod";

function emptyToUndefined(value: unknown) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

export function readEnvironment(values: NodeJS.ProcessEnv) {
  return z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    MYSQL_URL: z.string().min(1, "MYSQL_URL is required"),
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    UPLOAD_DIR: z.string().default("./uploads"),
    ADMIN_EMAIL: z.preprocess(emptyToUndefined, z.string().email().optional()),
    ADMIN_PASSWORD: z.preprocess(emptyToUndefined, z.string().min(10).optional()),
    ADMIN_NAME: z.preprocess(emptyToUndefined, z.string().min(1).default("系统管理员")),
    OPENAI_API_KEY: optionalString,
    OPENAI_CHAT_MODEL: z.preprocess(emptyToUndefined, z.string().default("gpt-5.6")),
    OPENAI_EMBEDDING_MODEL: z.preprocess(emptyToUndefined, z.string().default("text-embedding-3-small")),
    DEEPSEEK_API_KEY: optionalString,
    DEEPSEEK_CHAT_MODEL: z.preprocess(emptyToUndefined, z.string().default("deepseek-v4-flash")),
  }).superRefine((env, context) => {
    if (Boolean(env.ADMIN_EMAIL) !== Boolean(env.ADMIN_PASSWORD)) {
      context.addIssue({ code: "custom", path: [env.ADMIN_EMAIL ? "ADMIN_PASSWORD" : "ADMIN_EMAIL"], message: "ADMIN_EMAIL and ADMIN_PASSWORD must be configured together" });
    }
  }).parse(values);
}
