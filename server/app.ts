import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import cors from "cors";
import cookieParser from "cookie-parser";
import express, { type Response } from "express";
import multer from "multer";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { z } from "zod";
import { assertChatConfigured, citationsFrom, replaceDocumentChunks, retrieve, streamAnswer } from "./ai";
import { clearSession, issueSession, requireAdmin, requireUser, verifyPassword } from "./auth";
import { config } from "./config";
import { countUsers, db } from "./db";
import { extractText, isSupportedFile } from "./documents";
import { parseJsonColumn } from "./json";
import type { AuthedRequest, Citation, Provider, Role } from "./types";
import { attachmentRouter } from "./attachments";
import { chatTurnRouter, streamChatTurn } from "./chat-turns";
import { ChatError } from "./chat-errors";
import { searchWeb } from "./web-search";
import { usedCitations } from "../shared/citations";

export const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, done) => done(null, config.uploadDir),
    filename: (_req, file, done) => done(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, done) => done(null, isSupportedFile(file.originalname)),
});

function sendEvent(res: Response, type: string, data: unknown) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function audit(userId: number | null, action: string, targetType?: string, targetId?: string, detail?: unknown, executor: Pick<typeof db, "execute"> = db) {
  await executor.execute(
    "INSERT INTO audit_logs (id, user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
    [randomUUID(), userId, action, targetType ?? null, targetId ?? null, detail ? JSON.stringify(detail) : null],
  );
}

async function ownedConversation(id: string, userId: number) {
  const [rows] = await db.execute<RowDataPacket[]>("SELECT id FROM conversations WHERE id = ? AND user_id = ?", [id, userId]);
  return rows.length > 0;
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/setup", async (_req, res, next) => {
  try {
    res.json({ needsSetup: (await countUsers()) === 0 });
  } catch (error) { next(error); }
});

app.post("/api/setup", async (req, res, next) => {
  try {
    if ((await countUsers()) > 0) return res.status(409).json({ error: "系统已经初始化，请直接登录。" });
    const input = z.object({ email: z.string().email(), password: z.string().min(10), displayName: z.string().min(1).max(100) }).parse(req.body);
    const bcrypt = await import("bcryptjs");
    const [result] = await db.execute<ResultSetHeader>(
      "INSERT INTO users (email, display_name, password_hash, role) VALUES (?, ?, ?, 'admin')",
      [input.email.toLowerCase(), input.displayName, await bcrypt.default.hash(input.password, 12)],
    );
    const user = { id: Number(result.insertId), email: input.email.toLowerCase(), displayName: input.displayName, role: "admin" as const };
    issueSession(res, user);
    await audit(user.id, "setup_complete", "user", String(user.id));
    return res.status(201).json({ user });
  } catch (error) { next(error); }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const input = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const user = await verifyPassword(input.email, input.password);
    if (!user) return res.status(401).json({ error: "邮箱或密码不正确。" });
    issueSession(res, user);
    await audit(user.id, "login", "user", String(user.id));
    return res.json({ user });
  } catch (error) { next(error); }
});

app.post("/api/auth/logout", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    clearSession(res);
    await audit(req.user!.id, "logout", "user", String(req.user!.id));
    return res.status(204).end();
  } catch (error) { next(error); }
});

app.get("/api/auth/me", requireUser, (req: AuthedRequest, res) => res.json({ user: req.user }));

// Browser mutations must originate from this host; CLI clients without Origin still use authentication.
app.use("/api", (req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("origin")) {
    try {
      if (new URL(req.get("origin")!).hostname !== req.hostname) return res.status(403).json({ error: "不允许跨站修改会话。" });
    } catch { return res.status(403).json({ error: "请求来源无效。" }); }
  }
  next();
});
app.use("/api", attachmentRouter, chatTurnRouter);

app.get("/api/conversations", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [rows] = await db.execute<RowDataPacket[]>(
      "SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100",
      [req.user!.id],
    );
    res.json({ conversations: rows });
  } catch (error) { next(error); }
});

app.get("/api/conversations/:id", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const conversationId = String(req.params.id);
    if (!(await ownedConversation(conversationId, req.user!.id))) return res.status(404).json({ error: "对话不存在。" });
    const [messages] = await db.execute<RowDataPacket[]>(
      `SELECT m.id, m.role, m.content, m.provider, m.citations, m.web_search, m.created_at, f.rating AS feedback
       FROM messages m LEFT JOIN feedback f ON f.message_id = m.id AND f.user_id = ?
       WHERE m.conversation_id = ? ORDER BY m.created_at ASC, m.sequence_no ASC`,
      [req.user!.id, conversationId],
    );
    res.json({ messages: messages.map((message) => ({ ...message, webSearch: Boolean(message.web_search), citations: usedCitations(message.content, parseJsonColumn<Citation[]>(message.citations, [])) })) });
  } catch (error) { next(error); }
});

app.post("/api/chat/stream", requireUser, async (req: AuthedRequest, res, next) => {
  if (Object.hasOwn(req.body ?? {}, "requestId")) return streamChatTurn(req, res, next);
  let streamOpen = false;
  try {
    const input = z.object({
      question: z.string().min(2).max(4000),
      conversationId: z.string().uuid().optional(),
      provider: z.enum(["openai", "deepseek", "gemini"]).default("gemini"),
      webSearch: z.boolean().default(false),
    }).parse(req.body);
    assertChatConfigured(input.provider);
    const userId = req.user!.id;
    const conversationId = input.conversationId ?? randomUUID();
    if (input.conversationId) {
      const [enhanced] = await db.execute<RowDataPacket[]>("SELECT id FROM conversation_turns WHERE conversation_id = ? LIMIT 1", [input.conversationId]);
      if (enhanced.length) throw new ChatError("此对话需携带 requestId 以保证重试和并发安全。", 400);
    }
    if (input.conversationId && !(await ownedConversation(conversationId, userId))) return res.status(404).json({ error: "对话不存在。" });
    if (!input.conversationId) {
      const title = input.question.replace(/\s+/g, " ").slice(0, 42);
      await db.execute("INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)", [conversationId, userId, title]);
    }
    await db.execute("INSERT INTO messages (id, conversation_id, role, content, web_search) VALUES (?, ?, 'user', ?, ?)", [randomUUID(), conversationId, input.question, input.webSearch]);
    await db.execute("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [conversationId]);

    const [context, webResult] = await Promise.all([
      retrieve(input.question),
      input.webSearch ? searchWeb({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_CHAT_MODEL, baseUrl: config.GEMINI_BASE_URL }, input.question) : undefined,
    ]);
    const [historyRows] = await db.execute<RowDataPacket[]>(
      "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, sequence_no DESC LIMIT 8",
      [conversationId],
    );
    const history = historyRows.reverse().slice(0, -1).map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));

    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.flushHeaders();
    streamOpen = true;
    // Candidate documents are not confirmed sources until generation is complete.
    sendEvent(res, "sources", { citations: [], webSearch: input.webSearch, webResult });
    const answer = await streamAnswer(input.provider as Provider, input.question, history, context, (text) => sendEvent(res, "delta", { text }));
    const messageId = randomUUID();
    const citations = citationsFrom(context, answer);
    await db.execute(
      "INSERT INTO messages (id, conversation_id, role, content, provider, citations, web_search) VALUES (?, ?, 'assistant', ?, ?, ?, ?)",
      [messageId, conversationId, answer, input.provider, JSON.stringify(citations), input.webSearch],
    );
    await db.execute("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [conversationId]);
    // Search output is shown unchanged to this user only; it is not indexed, persisted, or reused by another model.
    await audit(userId, "ask_question", "conversation", conversationId, { provider: input.provider, sources: citations.length, ...(input.webSearch ? { webSearch: true, webSources: webResult?.sources.length ?? 0 } : {}) });
    sendEvent(res, "done", { conversationId, messageId, citations, webSearch: input.webSearch, webResult });
    return res.end();
  } catch (error) {
    if (streamOpen) { sendEvent(res, "error", { error: error instanceof Error ? error.message : "生成回答失败。" }); return res.end(); }
    return next(error);
  }
});

app.post("/api/feedback", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const input = z.object({ messageId: z.string().uuid(), rating: z.enum(["up", "down"]), note: z.string().max(1000).optional() }).parse(req.body);
    const [messages] = await db.execute<RowDataPacket[]>(
      `SELECT m.id FROM messages m INNER JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = ? AND m.role = 'assistant' AND c.user_id = ?`,
      [input.messageId, req.user!.id],
    );
    if (!messages.length) return res.status(404).json({ error: "回答不存在。" });
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      // The existing unique key makes first-write-wins safe across double clicks and multiple tabs.
      await connection.execute(
        "INSERT INTO feedback (id, message_id, user_id, rating, note) VALUES (?, ?, ?, ?, ?)",
        [randomUUID(), input.messageId, req.user!.id, input.rating, input.note ?? null],
      );
      await audit(req.user!.id, "feedback", "message", input.messageId, { rating: input.rating }, connection);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (error instanceof Error && "code" in error && error.code === "ER_DUP_ENTRY") {
        const [saved] = await connection.execute<RowDataPacket[]>("SELECT rating FROM feedback WHERE message_id = ? AND user_id = ?", [input.messageId, req.user!.id]);
        if (saved.length) return res.status(409).json({ error: "该回答已评价，每条回答只能评价一次。", rating: saved[0].rating });
      }
      throw error;
    } finally {
      connection.release();
    }
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get("/api/documents/:id/download", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [rows] = await db.execute<RowDataPacket[]>("SELECT filename, storage_path FROM documents WHERE id = ? AND status = 'ready'", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "文件不存在。" });
    return res.download(rows[0].storage_path, rows[0].filename);
  } catch (error) { next(error); }
});

app.get("/api/admin/documents", requireUser, requireAdmin, async (_req: AuthedRequest, res, next) => {
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT d.id, d.title, d.filename, d.mime_type, d.size_bytes, d.status, d.error_message, d.created_at, d.updated_at,
       u.display_name AS uploader_name, COUNT(c.id) AS chunk_count
       FROM documents d INNER JOIN users u ON u.id = d.uploaded_by LEFT JOIN document_chunks c ON c.document_id = d.id
       GROUP BY d.id ORDER BY d.updated_at DESC`,
    );
    res.json({ documents: rows });
  } catch (error) { next(error); }
});

app.post("/api/admin/documents", requireUser, requireAdmin, upload.single("file"), async (req: AuthedRequest, res, next) => {
  const file = req.file;
  let documentId: string | undefined;
  let indexed = false;
  try {
    if (!file) return res.status(400).json({ error: "请选择 PDF、DOCX、XLSX、XLS 或 TXT 文件。" });
    const content = (await extractText(file.path, file.originalname)).trim();
    if (content.length < 20) {
      await fs.unlink(file.path);
      return res.status(400).json({ error: "未能从文件中提取足够文本；请确认文件不是扫描图片或受密码保护。" });
    }
    const id = randomUUID();
    const title = path.basename(file.originalname, path.extname(file.originalname));
    await db.execute(
      "INSERT INTO documents (id, title, filename, mime_type, storage_path, content, size_bytes, status, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?)",
      [id, title, file.originalname, file.mimetype || "application/octet-stream", file.path, content, file.size, req.user!.id],
    );
    documentId = id;
    const chunks = await replaceDocumentChunks(id, content);
    indexed = true;
    await audit(req.user!.id, "upload_document", "document", id, { filename: file.originalname, chunks });
    res.status(201).json({ document: { id, title, filename: file.originalname, chunks, status: "ready" } });
  } catch (error) {
    if (documentId && !indexed) {
      try {
        await db.execute("UPDATE documents SET status = 'failed', error_message = ? WHERE id = ?", [error instanceof Error ? error.message : "索引失败", documentId]);
      } catch (statusError) { console.error("无法保存文档失败状态", statusError); }
    } else if (!documentId && file) {
      await fs.unlink(file.path).catch(() => undefined);
    }
    next(error);
  }
});

app.post("/api/admin/documents/:id/reindex", requireUser, requireAdmin, async (req: AuthedRequest, res, next) => {
  let started = false;
  let indexed = false;
  try {
    const documentId = String(req.params.id);
    const [rows] = await db.execute<RowDataPacket[]>("SELECT content FROM documents WHERE id = ?", [documentId]);
    if (!rows[0]) return res.status(404).json({ error: "文档不存在。" });
    await db.execute("UPDATE documents SET status = 'processing', error_message = NULL WHERE id = ?", [documentId]);
    started = true;
    const chunks = await replaceDocumentChunks(documentId, rows[0].content);
    indexed = true;
    await audit(req.user!.id, "reindex_document", "document", documentId, { chunks });
    res.json({ chunks });
  } catch (error) {
    if (started && !indexed) {
      try {
        await db.execute("UPDATE documents SET status = 'failed', error_message = ? WHERE id = ?", [error instanceof Error ? error.message : "索引失败", String(req.params.id)]);
      } catch (statusError) { console.error("无法保存文档失败状态", statusError); }
    }
    next(error);
  }
});

app.delete("/api/admin/documents/:id", requireUser, requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const documentId = String(req.params.id);
    const [rows] = await db.execute<RowDataPacket[]>("SELECT storage_path FROM documents WHERE id = ?", [documentId]);
    if (!rows[0]) return res.status(404).json({ error: "文档不存在。" });
    await db.execute("DELETE FROM documents WHERE id = ?", [documentId]);
    await fs.unlink(rows[0].storage_path).catch(() => undefined);
    await audit(req.user!.id, "delete_document", "document", documentId);
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get("/api/admin/users", requireUser, requireAdmin, async (_req: AuthedRequest, res, next) => {
  try {
    const [rows] = await db.query<RowDataPacket[]>("SELECT id, email, display_name, role, is_active, created_at FROM users ORDER BY created_at ASC");
    res.json({ users: rows });
  } catch (error) { next(error); }
});

app.post("/api/admin/users", requireUser, requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const input = z.object({ email: z.string().email(), displayName: z.string().min(1).max(100), password: z.string().min(10), role: z.enum(["employee", "admin"]).default("employee") }).parse(req.body);
    const bcrypt = await import("bcryptjs");
    const [result] = await db.execute<ResultSetHeader>(
      "INSERT INTO users (email, display_name, password_hash, role) VALUES (?, ?, ?, ?)",
      [input.email.toLowerCase(), input.displayName, await bcrypt.default.hash(input.password, 12), input.role],
    );
    await audit(req.user!.id, "create_user", "user", String(result.insertId), { role: input.role });
    res.status(201).json({ id: Number(result.insertId) });
  } catch (error) { next(error); }
});

app.patch("/api/admin/users/:id", requireUser, requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const input = z.object({ role: z.enum(["employee", "admin"]).optional(), isActive: z.boolean().optional() }).refine((value) => value.role !== undefined || value.isActive !== undefined).parse(req.body);
    const id = z.coerce.number().int().positive().parse(req.params.id);
    if (id === req.user!.id && input.isActive === false) return res.status(400).json({ error: "不能停用当前登录的管理员。" });
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      // Lock administrators in a consistent order so concurrent changes cannot remove all of them.
      const [admins] = await connection.query<RowDataPacket[]>("SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE ORDER BY id FOR UPDATE");
      const [users] = await connection.execute<RowDataPacket[]>("SELECT role, is_active FROM users WHERE id = ? FOR UPDATE", [id]);
      if (!users.length) {
        await connection.rollback();
        return res.status(404).json({ error: "成员不存在。" });
      }
      const removesAdmin = users[0].role === "admin" && users[0].is_active && (input.role === "employee" || input.isActive === false);
      if (removesAdmin && admins.length <= 1) {
        await connection.rollback();
        return res.status(400).json({ error: "系统必须保留至少一位已启用的管理员。" });
      }
      if (input.role !== undefined) await connection.execute("UPDATE users SET role = ? WHERE id = ?", [input.role as Role, id]);
      if (input.isActive !== undefined) await connection.execute("UPDATE users SET is_active = ? WHERE id = ?", [input.isActive, id]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    await audit(req.user!.id, "update_user", "user", String(id), input);
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get("/api/admin/audit", requireUser, requireAdmin, async (_req: AuthedRequest, res, next) => {
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at, u.display_name AS user_name, u.email AS user_email
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 200`,
    );
    res.json({ logs: rows.map((row) => ({ ...row, detail: parseJsonColumn(row.detail, null) })) });
  } catch (error) { next(error); }
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.resolve("dist")));
  app.use((_req, res) => res.sendFile(path.resolve("dist/index.html")));
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  void _next;
  if (error instanceof ChatError) return res.status(error.status).json({ error: error.message, code: error.code });
  console.error(error);
  if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? "请求参数不正确。" });
  if (error instanceof multer.MulterError) return res.status(400).json({ error: `上传失败：${error.message}` });
  const message = error instanceof Error ? error.message : "服务器发生未知错误。";
  return res.status(500).json({ error: message });
});
