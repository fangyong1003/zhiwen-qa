import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { db } from "./db";
import { config } from "./config";
import { requireUser } from "./auth";
import { ChatError } from "./chat-errors";
import type { AuthedRequest } from "./types";
import { isSupportedFile } from "./documents";
import { splitText } from "./chunks";
import { embeddingSettings } from "./ai";
import { createGeminiEmbeddings, embeddingSpace } from "./embeddings";
import { MAX_ATTACHMENT_BYTES } from "./file-validation";

const privateDir = path.join(config.uploadDir, "private");
const jobs = new Map<string, AbortController>();

export async function lockConversation(connection: PoolConnection, conversationId: string, userId: number, allowBusy = false) {
  const [rows] = await connection.execute<RowDataPacket[]>(
    "SELECT *, active_until > NOW() AS busy FROM conversations WHERE id = ? AND user_id = ? FOR UPDATE", [conversationId, userId],
  );
  if (!rows[0]) throw new ChatError("对话不存在。", 404);
  if (!allowBusy && rows[0].busy && rows[0].active_request_id) throw new ChatError("本对话正在生成回答，请先停止或等待完成。", 409, "busy");
  return rows[0];
}

function parseInWorker(filePath: string, filename: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./attachment-parser.mjs", import.meta.url), { workerData: { filePath, filename }, resourceLimits: { maxOldGenerationSizeMb: 192 } });
    const timer = setTimeout(() => finish(new Error("附件解析超时，请拆分文件或转换为 TXT。")), 20000);
    const abort = () => finish(new Error("附件处理已取消。"));
    let settled = false;
    function finish(error?: Error, text?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error); else resolve(text!);
    }
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (value: { text?: string; error?: string }) => finish(value.error ? new Error(value.error) : undefined, value.text));
    worker.once("error", () => finish(new Error("附件解析超出资源限制或文件无效。")));
    worker.once("exit", () => { if (!settled) finish(new Error("附件解析进程意外退出。")); });
  });
}

async function indexAttachment(id: string, filePath: string, filename: string, controller: AbortController) {
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
  try {
    const content = await parseInWorker(filePath, filename, signal);
    signal.throwIfAborted();
    await db.execute("UPDATE conversation_attachments SET status = 'indexing', content = ? WHERE id = ?", [content, id]);
    const chunks = splitText(content);
    const settings = embeddingSettings();
    const vectors = await createGeminiEmbeddings(settings, chunks, "document", signal);
    signal.throwIfAborted();
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [row] = await connection.execute<RowDataPacket[]>("SELECT id FROM conversation_attachments WHERE id = ? FOR UPDATE", [id]);
      if (!row.length || signal.aborted) throw new Error("附件处理已取消。");
      for (let i = 0; i < chunks.length; i++) {
        await connection.execute("INSERT INTO attachment_chunks (id, attachment_id, chunk_index, content, embedding, embedding_space) VALUES (?, ?, ?, ?, ?, ?)", [randomUUID(), id, i, chunks[i], JSON.stringify(vectors[i]), embeddingSpace(settings)]);
      }
      await connection.execute("UPDATE conversation_attachments SET status = 'ready', error_message = NULL WHERE id = ?", [id]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  } catch (error) {
    const message = signal.aborted ? "附件处理已中断，请重试解析。" : error instanceof Error ? error.message : "附件处理失败，请重试。";
    await db.execute("UPDATE conversation_attachments SET status = 'failed', error_message = ? WHERE id = ?", [message.slice(0, 1000), id]).catch(() => undefined);
  } finally { if (jobs.get(id) === controller) jobs.delete(id); }
}

function startIndex(id: string, filePath: string, filename: string) {
  const controller = jobs.get(id) ?? new AbortController();
  jobs.set(id, controller);
  void indexAttachment(id, filePath, filename, controller);
}

export const attachmentRouter = Router();
attachmentRouter.use(requireUser);
attachmentRouter.post("/conversations", async (req: AuthedRequest, res, next) => {
  try {
    const { id = randomUUID() } = z.object({ id: z.string().uuid().optional() }).parse(req.body ?? {});
    const [existing] = await db.execute<RowDataPacket[]>("SELECT user_id FROM conversations WHERE id = ?", [id]);
    if (existing.length && Number(existing[0].user_id) !== req.user!.id) throw new ChatError("对话不存在。", 404);
    if (!existing.length) await db.execute("INSERT INTO conversations (id, user_id, title) VALUES (?, ?, '新对话')", [id, req.user!.id]);
    res.status(201).json({ conversation: { id } });
  } catch (error) { next(error); }
});

attachmentRouter.use("/conversations/:conversationId/attachments", async (req: AuthedRequest, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.conversationId);
    const [rows] = await db.execute<RowDataPacket[]>("SELECT id FROM conversations WHERE id = ? AND user_id = ?", [id, req.user!.id]);
    if (!rows.length) return res.status(404).json({ error: "对话不存在。" });
    next();
  } catch (error) { next(error); }
});

attachmentRouter.get("/conversations/:conversationId/attachments", async (req: AuthedRequest, res, next) => {
  try {
    await db.execute("UPDATE conversation_attachments SET status = 'failed', error_message = '上次处理已中断，请重试解析。' WHERE conversation_id = ? AND status IN ('parsing','indexing') AND updated_at < NOW() - INTERVAL 5 MINUTE", [req.params.conversationId]);
    const [attachments] = await db.execute<RowDataPacket[]>("SELECT a.id, a.filename, a.size_bytes, a.status, a.error_message, (SELECT COUNT(*) FROM attachment_chunks ch WHERE ch.attachment_id = a.id) AS chunk_count FROM conversation_attachments a WHERE conversation_id = ? ORDER BY created_at, id", [req.params.conversationId]);
    res.set("Cache-Control", "no-store").json({ attachments });
  } catch (error) { next(error); }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, done) => { fs.mkdir(privateDir, { recursive: true, mode: 0o700 }).then(() => done(null, privateDir), (error) => done(error, privateDir)); },
    filename: (_req, file, done) => done(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 0 },
  fileFilter: (_req, file, done) => {
    if ([...file.originalname].every((char) => char.charCodeAt(0) <= 255)) {
      try { file.originalname = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(file.originalname, "latin1")); } catch { /* Already decoded filename. */ }
    }
    if (!isSupportedFile(file.originalname) || file.originalname.length > 240 || [...file.originalname].some((char) => char.charCodeAt(0) < 32)) return done(new ChatError("仅支持文件名不超过 240 字符的 PDF、DOCX、XLSX、XLS 和 TXT。"));
    done(null, true);
  },
});

attachmentRouter.post("/conversations/:conversationId/attachments", upload.single("file"), async (req: AuthedRequest, res, next) => {
  const file = req.file;
  let inserted = false;
  const id = randomUUID();
  try {
    if (!file) throw new ChatError("请选择附件。");
    if (!config.GEMINI_API_KEY) throw new ChatError("附件索引需要 GEMINI_API_KEY。");
    if (jobs.size >= 4) throw new ChatError("附件处理队列已满，请稍后上传。", 429);
    jobs.set(id, new AbortController());
    await fs.chmod(file.path, 0o600);
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("SELECT id FROM users WHERE id = ? FOR UPDATE", [req.user!.id]);
      await lockConversation(connection, String(req.params.conversationId), req.user!.id);
      const [count] = await connection.execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM conversation_attachments WHERE conversation_id = ?", [req.params.conversationId]);
      if (Number(count[0].total) >= 5) throw new ChatError("每个对话最多保留 5 个附件，请先删除不需要的附件。");
      const [usage] = await connection.execute<RowDataPacket[]>("SELECT COALESCE(SUM(a.size_bytes),0) AS total FROM conversation_attachments a JOIN conversations c ON c.id = a.conversation_id WHERE c.user_id = ?", [req.user!.id]);
      if (Number(usage[0].total) + file.size > 100 * 1024 * 1024) throw new ChatError("个人附件存储已达 100 MB，请删除不需要的附件。");
      await connection.execute("INSERT INTO conversation_attachments (id, conversation_id, filename, storage_path, size_bytes) VALUES (?, ?, ?, ?, ?)", [id, req.params.conversationId, file.originalname, file.path, file.size]);
      await connection.commit();
      inserted = true;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    startIndex(id, file.path, file.originalname);
    res.status(202).json({ attachment: { id, filename: file.originalname, size_bytes: file.size, status: "parsing" } });
  } catch (error) {
    if (!inserted) jobs.delete(id);
    if (file && !inserted) await fs.unlink(file.path).catch(() => undefined);
    next(error);
  }
});

attachmentRouter.post("/conversations/:conversationId/attachments/:id/retry", async (req: AuthedRequest, res, next) => {
  const connection = await db.getConnection();
  let reserved: AbortController | undefined;
  try {
    await connection.beginTransaction();
    await lockConversation(connection, String(req.params.conversationId), req.user!.id);
    const [rows] = await connection.execute<RowDataPacket[]>("SELECT * FROM conversation_attachments WHERE id = ? AND conversation_id = ? FOR UPDATE", [req.params.id, req.params.conversationId]);
    if (!rows[0]) throw new ChatError("附件不存在。", 404);
    if (rows[0].status !== "failed" || jobs.has(String(req.params.id)) || jobs.size >= 4) throw new ChatError("附件正在处理或无需重试。", 409);
    reserved = new AbortController();
    jobs.set(String(req.params.id), reserved);
    await connection.execute("DELETE FROM attachment_chunks WHERE attachment_id = ?", [req.params.id]);
    await connection.execute("UPDATE conversation_attachments SET status = 'parsing', error_message = NULL WHERE id = ?", [req.params.id]);
    await connection.commit();
    startIndex(String(req.params.id), rows[0].storage_path, rows[0].filename);
    res.status(202).json({ ok: true });
  } catch (error) {
    await connection.rollback();
    if (reserved && jobs.get(String(req.params.id)) === reserved) jobs.delete(String(req.params.id));
    next(error);
  } finally { connection.release(); }
});

attachmentRouter.get("/conversations/:conversationId/attachments/:id/download", async (req: AuthedRequest, res, next) => {
  try {
    const [rows] = await db.execute<RowDataPacket[]>("SELECT filename, storage_path FROM conversation_attachments WHERE id = ? AND conversation_id = ?", [req.params.id, req.params.conversationId]);
    if (!rows[0]) throw new ChatError("附件不存在或已删除。", 404);
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox" }).download(rows[0].storage_path, rows[0].filename);
  } catch (error) { next(error); }
});

attachmentRouter.delete("/conversations/:conversationId/attachments/:id", async (req: AuthedRequest, res, next) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await lockConversation(connection, String(req.params.conversationId), req.user!.id);
    const [rows] = await connection.execute<RowDataPacket[]>("SELECT storage_path FROM conversation_attachments WHERE id = ? AND conversation_id = ? FOR UPDATE", [req.params.id, req.params.conversationId]);
    if (!rows[0]) throw new ChatError("附件不存在。", 404);
    jobs.get(String(req.params.id))?.abort();
    // Keep the row if removing its file fails, so the user can retry cleanup.
    await fs.unlink(rows[0].storage_path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await connection.execute("DELETE FROM conversation_attachments WHERE id = ?", [req.params.id]);
    await connection.execute("UPDATE conversations SET context_summary = NULL, summary_through = 0, context_reset_sequence = (SELECT COALESCE(MAX(sequence_no),0) FROM messages WHERE conversation_id = ?) WHERE id = ?", [req.params.conversationId, req.params.conversationId]);
    await connection.commit();
    res.sendStatus(204);
  } catch (error) { await connection.rollback(); next(error); } finally { connection.release(); }
});
