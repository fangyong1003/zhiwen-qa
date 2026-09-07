import "dotenv/config";
import path from "node:path";
import { readEnvironment } from "./environment";

const env = readEnvironment(process.env);

export const config = { ...env, uploadDir: path.resolve(env.UPLOAD_DIR) };
