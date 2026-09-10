import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Response } from "express";
import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import { db } from "./db";
import { config } from "./config";
import { requireUser } from "./auth";
import { lockConversation } from "./attachments";
import { ChatError } from "./chat-errors";
import { assertChatConfigured, citationsFrom, retrieve, streamText, systemPrompt } from "./ai";
import { searchWeb } from "./web-search";
import { parseJsonColumn } from "./json";
import { budgetPrompt, prepareConversationContext, textBudget, type HistoryMessage } from "./conversation-context";
import type { AuthedRequest, Citation } from "./types";
import type { TurnRequest } from "../shared/chat";

const running = new Map<string, AbortController>();
const turnSchema = z.object({
  requestId: z.string().uuid(), conversationId: z.string().uuid(), question: z.string().trim().min(2).max(4000),
  provider: z.enum(["gemini", "openai", "deepseek"]).default("gemini"), webSearch: z.boolean().default(false),
  scope: z.enum(["knowledge", "attachments", "combined"]).default("knowledge"),
  attachmentIds: z.array(z.string().uuid()).max(5).default([]),
});

export const chatTurnRouter = Router();
chatTurnRouter.get("/conversations/:id/turns", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [conversation] = await db.execute<RowDataPacket[]>("SELECT id, context_summary IS NOT NULL AS compressed FROM conversations WHERE id = ? AND user_id = ?", [req.params.id, req.user!.id]);
    if (!conversation.length) throw new ChatError("对话不存在。", 404);
    await db.execute("UPDATE conversation_turns t JOIN conversations c ON c.id = t.conversation_id SET t.status = 'failed', t.error_message = '上次回答已中断，可重试。', t.error_code = 'interrupted' WHERE c.id = ? AND t.status = 'running' AND (c.active_until IS NULL OR c.active_until < NOW())", [req.params.id]);
    const [rows] = await db.execute<RowDataPacket[]>("SELECT id, user_message_id, assistant_message_id, status, partial_content, error_message, error_code, request FROM conversation_turns WHERE conversation_id = ? ORDER BY created_at, id", [req.params.id]);
    res.set("Cache-Control", "no-store").json({ turns: rows.map((row) => ({ ...row, request: parseJsonColumn<TurnRequest | null>(row.request, null) })), compressed: Boolean(conversation[0].compressed) });
  } catch (error) { next(error); }
});

chatTurnRouter.post("/chat/turns/:id/cancel", requireUser, async (req: AuthedRequest, res, next) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [target] = await connection.execute<RowDataPacket[]>("SELECT t.conversation_id FROM conversation_turns t JOIN conversations c ON c.id = t.conversation_id WHERE t.id = ? AND c.user_id = ?", [req.params.id, req.user!.id]);
    if (!target.length) throw new ChatError("问题不存在。", 404);
    await lockConversation(connection, target[0].conversation_id, req.user!.id, true);
    const [rows] = await connection.execute<RowDataPacket[]>("SELECT status, run_token FROM conversation_turns WHERE id = ? FOR UPDATE", [req.params.id]);
    if (rows[0].status === "running") {
      await connection.execute("UPDATE conversation_turns SET status = 'cancelled', error_code = 'cancelled', error_message = '已停止生成，可重试。' WHERE id = ?", [req.params.id]);
      await connection.execute("UPDATE conversations SET active_request_id = NULL, active_until = NULL WHERE id = ? AND active_request_id = ?", [target[0].conversation_id, rows[0].run_token]);
    }
    await connection.commit();
    if (rows[0].status === "running") running.get(String(req.params.id))?.abort("cancelled");
    res.json({ status: rows[0].status === "running" ? "cancelled" : rows[0].status });
  } catch (error) { await connection.rollback(); next(error); } finally { connection.release(); }
});

async function reserveTurn(input: TurnRequest, userId: number, token: string) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const conversation = await lockConversation(connection, input.conversationId, userId, true);
    const [turns] = await connection.execute<RowDataPacket[]>("SELECT * FROM conversation_turns WHERE id = ? FOR UPDATE", [input.requestId]);
    const previous = turns[0];
    if (previous) {
      if (previous.conversation_id !== input.conversationId) throw new ChatError("问题编号不可用于此对话。", 409);
      const old = parseJsonColumn<TurnRequest>(previous.request, input);
      const same = old.question === input.question && old.provider === input.provider && old.scope === input.scope && JSON.stringify([...old.attachmentIds].sort()) === JSON.stringify([...input.attachmentIds].sort());
      if (!same || (old.webSearch !== input.webSearch && !(old.webSearch && !input.webSearch && previous.error_code === "search_failed"))) throw new ChatError("重试参数与原问题不一致，请发起新问题。", 409);
      if (previous.status === "completed") { await connection.commit(); return { previous, conversation, userMessageId: previous.user_message_id, replay: true }; }
    }
    if (conversation.busy && conversation.active_request_id) throw new ChatError("本对话正在生成回答，请先停止或等待完成。", 409, "busy");
    if (previous) {
      const [latest] = await connection.execute<RowDataPacket[]>("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY sequence_no DESC LIMIT 1", [input.conversationId]);
      if (latest[0]?.id !== previous.user_message_id) throw new ChatError("已继续此对话，请将旧问题作为新问题发送。", 409);
    }
    if (input.scope !== "knowledge") {
      if (!input.attachmentIds.length) throw new ChatError("请先上传并选择可用附件。");
      const [attachments] = await connection.query<RowDataPacket[]>("SELECT id, status FROM conversation_attachments WHERE conversation_id = ? AND id IN (?)", [input.conversationId, input.attachmentIds]);
      if (attachments.length !== input.attachmentIds.length) throw new ChatError("附件不存在或不属于当前对话。", 404);
      if (attachments.some((item) => item.status !== "ready")) throw new ChatError("附件尚未处理完成，请稍后发送。", 409);
    } else if (input.attachmentIds.length) throw new ChatError("仅知识库模式不能携带附件，请切换资料范围。");
    await connection.execute("UPDATE conversation_turns SET status = 'failed', error_code = 'interrupted', error_message = '上次回答已中断，可重试。' WHERE conversation_id = ? AND status = 'running'", [input.conversationId]);
    const userMessageId = previous?.user_message_id ?? randomUUID();
    if (!previous) {
      const [count] = await connection.execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ?", [input.conversationId]);
      if (!Number(count[0].total)) await connection.execute("UPDATE conversations SET title = ? WHERE id = ?", [input.question.replace(/\s+/g, " ").slice(0, 42), input.conversationId]);
      await connection.execute("INSERT INTO messages (id, conversation_id, role, content, web_search) VALUES (?, ?, 'user', ?, ?)", [userMessageId, input.conversationId, input.question, input.webSearch]);
      await connection.execute("INSERT INTO conversation_turns (id, run_token, conversation_id, user_message_id, request, partial_content) VALUES (?, ?, ?, ?, ?, '')", [input.requestId, token, input.conversationId, userMessageId, JSON.stringify(input)]);
    } else {
      await connection.execute("UPDATE conversation_turns SET run_token = ?, request = ?, status = 'running', error_message = NULL, error_code = NULL, partial_content = '' WHERE id = ?", [token, JSON.stringify(input), input.requestId]);
      await connection.execute("UPDATE messages SET web_search = ? WHERE id = ?", [input.webSearch, userMessageId]);
    }
    await connection.execute("UPDATE conversations SET active_request_id = ?, active_until = NOW() + INTERVAL 4 MINUTE, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [token, input.conversationId]);
    await connection.commit();
    return { previous, conversation, userMessageId, replay: false };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

export async function streamChatTurn(req: AuthedRequest, res: Response, next: NextFunction) {
  let input: TurnRequest | undefined;
  const controller = new AbortController();
  const token = randomUUID();
  let reserved = false;
  let opened = false;
  let answer = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeatBusy = false;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
  const send = (type: string, data: unknown) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  const disconnected = () => { if (!res.writableEnded) controller.abort("disconnected"); };
  try {
    input = turnSchema.parse(req.body);
    if (new Set(input.attachmentIds).size !== input.attachmentIds.length) throw new ChatError("附件列表不能重复。");
    assertChatConfigured(input.provider);
    const state = await reserveTurn(input, req.user!.id, token);
    reserved = !state.replay;
    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    opened = true;
    send("meta", { requestId: input.requestId, conversationId: input.conversationId, userMessageId: state.userMessageId, replay: state.replay });
    if (state.replay) {
      const [messages] = await db.execute<RowDataPacket[]>("SELECT id, content, citations FROM messages WHERE id = ?", [state.previous.assistant_message_id]);
      if (!messages[0]) throw new ChatError("已完成的回答不存在，请重新提问。", 409);
      send("delta", { text: messages[0].content });
      send("done", { conversationId: input.conversationId, requestId: input.requestId, messageId: messages[0].id, citations: parseJsonColumn<Citation[]>(messages[0].citations, []), webSearch: input.webSearch });
      return res.end();
    }
    running.set(input.requestId, controller);
    res.once("close", disconnected);
    if (res.destroyed) controller.abort("disconnected");
    const request = input;
    timer = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void (async () => {
        const [rows] = await db.execute<RowDataPacket[]>("SELECT t.status, t.run_token, u.is_active FROM conversation_turns t JOIN conversations c ON c.id = t.conversation_id JOIN users u ON u.id = c.user_id WHERE t.id = ?", [request.requestId]);
        if (!rows[0] || rows[0].status !== "running" || rows[0].run_token !== token || !rows[0].is_active) controller.abort("cancelled");
        else await db.execute("UPDATE conversation_turns SET partial_content = ? WHERE id = ? AND run_token = ? AND status = 'running'", [answer, request.requestId, token]);
        if (!signal.aborted) send("heartbeat", {});
      })().catch(() => controller.abort("state_failed")).finally(() => { heartbeatBusy = false; });
    }, 1500);
    send("progress", { stage: "context", label: "理解追问与整理上下文" });
    const floor = Math.max(Number(state.conversation.summary_through), Number(state.conversation.context_reset_sequence));
    const [historyRows] = await db.execute<RowDataPacket[]>(
      `SELECT m.role, m.content, m.sequence_no FROM messages m
       LEFT JOIN conversation_turns t ON t.user_message_id = m.id OR t.assistant_message_id = m.id
       WHERE m.conversation_id = ? AND m.id <> ? AND m.sequence_no > ? AND (t.id IS NULL OR t.status = 'completed')
       ORDER BY m.sequence_no DESC LIMIT 100`, [input.conversationId, state.userMessageId, floor],
    );
    const [files] = input.attachmentIds.length ? await db.query<RowDataPacket[]>("SELECT filename FROM conversation_attachments WHERE conversation_id = ? AND id IN (?)", [input.conversationId, input.attachmentIds]) : [[]];
    const memory = await prepareConversationContext(
      historyRows.reverse() as HistoryMessage[], state.conversation.context_summary ?? "", Number(state.conversation.summary_through),
      input.question, files.map((file) => String(file.filename)),
      (instructions, text) => {
        if (textBudget(instructions) + textBudget(text) + 1024 > config.CHAT_CONTEXT_TOKENS) throw new ChatError("上下文整理超出输入预算，请缩短问题或提高 CHAT_CONTEXT_TOKENS 配置。", 400);
        return streamText(request.provider, text, [], instructions, () => undefined, signal);
      },
    );
    signal.throwIfAborted();
    send("context", { compressed: memory.compressed || Boolean(memory.summary), retainedMessages: memory.history.length });
    let context: Awaited<ReturnType<typeof retrieve>> = [];
    let webResult;
    const delta = (text: string) => {
      signal.throwIfAborted();
      if (answer.length + text.length > 100000) throw new ChatError("回答过长，请缩小问题范围。", 400);
      answer += text;
      send("delta", { text });
    };
    if (memory.clarification) {
      send("sources", { citations: [], webSearch: false });
      delta(memory.clarification);
    } else {
      send("progress", { stage: "retrieval", label: input.scope === "knowledge" ? "检索公司知识库" : "检索会话附件与所选资料" });
      context = await retrieve(memory.query, 10, { userId: req.user!.id, conversationId: input.conversationId, scope: input.scope, attachmentIds: input.attachmentIds, signal });
      if (input.webSearch) {
        send("progress", { stage: "search", label: "查询公开网页（不发送附件与历史）" });
        try { webResult = await searchWeb({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_CHAT_MODEL, baseUrl: config.GEMINI_BASE_URL }, input.question, signal); }
        catch (error) { signal.throwIfAborted(); throw new ChatError(error instanceof Error ? error.message : "联网搜索失败。", 502, "search_failed"); }
      }
      const prompt = budgetPrompt(input.question, memory.summary, memory.history, context, config.CHAT_CONTEXT_TOKENS, systemPrompt);
      context = prompt.context;
      send("sources", { citations: [], webSearch: input.webSearch, webResult });
      send("progress", { stage: "generating", label: "生成回答", estimatedContext: prompt.estimated, contextBudget: config.CHAT_CONTEXT_TOKENS });
      await streamText(input.provider, input.question, prompt.history, prompt.instructions, delta, signal);
    }
    signal.throwIfAborted();
    const citations = citationsFrom(context, answer);
    const messageId = randomUUID();
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const conversation = await lockConversation(connection, input.conversationId, req.user!.id, true);
      const [turn] = await connection.execute<RowDataPacket[]>("SELECT status, run_token FROM conversation_turns WHERE id = ? FOR UPDATE", [input.requestId]);
      if (conversation.active_request_id !== token || turn[0]?.status !== "running" || turn[0]?.run_token !== token) throw new ChatError("此回答已停止或被新的请求替代。", 409, "cancelled");
      const [user] = await connection.execute<RowDataPacket[]>("SELECT is_active FROM users WHERE id = ?", [req.user!.id]);
      if (!user[0]?.is_active) throw new ChatError("账号已停用。", 401);
      signal.throwIfAborted();
      await connection.execute("INSERT INTO messages (id, conversation_id, role, content, provider, citations, web_search) VALUES (?, ?, 'assistant', ?, ?, ?, ?)", [messageId, input.conversationId, answer, input.provider, JSON.stringify(citations), input.webSearch && !memory.clarification]);
      await connection.execute("UPDATE conversation_turns SET status = 'completed', assistant_message_id = ?, partial_content = '', error_code = NULL, error_message = NULL WHERE id = ? AND run_token = ?", [messageId, input.requestId, token]);
      await connection.execute("UPDATE conversations SET context_summary = ?, summary_through = ?, active_request_id = NULL, active_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [memory.summary || null, memory.through, input.conversationId]);
      await connection.execute("INSERT INTO audit_logs (id, user_id, action, target_type, target_id, detail) VALUES (?, ?, 'ask_question', 'conversation', ?, ?)", [randomUUID(), req.user!.id, input.conversationId, JSON.stringify({ provider: input.provider, sources: citations.length, scope: input.scope, webSearch: input.webSearch && !memory.clarification, contextCompressed: Boolean(memory.summary) })]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    send("done", { conversationId: input.conversationId, requestId: input.requestId, messageId, citations, webSearch: input.webSearch && !memory.clarification, webResult });
    return res.end();
  } catch (error) {
    const cancelled = controller.signal.aborted || (error instanceof ChatError && error.code === "cancelled");
    const message = cancelled ? "已停止生成，可重试。" : signal.aborted ? "处理超时，请重试或缩小资料范围。" : error instanceof ChatError ? error.message : error instanceof z.ZodError ? "参数或上下文整理结果无效，请重试。" : error instanceof Error && /^(Gemini|DeepSeek|OpenAI|知识库|文档|问题与|上下文)/.test(error.message) ? error.message : "回答暂时失败，请重试。";
    const code = cancelled ? "cancelled" : error instanceof ChatError ? error.code : "generation_failed";
    if (reserved && input) await db.execute("UPDATE conversation_turns SET status = ?, partial_content = ?, error_message = ?, error_code = ? WHERE id = ? AND run_token = ? AND status IN ('running','cancelled')", [cancelled ? "cancelled" : "failed", answer, message.slice(0, 1000), code, input.requestId, token]).catch(() => undefined);
    if (opened) { send(cancelled ? "cancelled" : "error", { error: message, code, requestId: input?.requestId, canContinueWithoutSearch: code === "search_failed" }); return res.end(); }
    next(error instanceof ChatError || error instanceof z.ZodError ? error : new ChatError(message, 500, code));
  } finally {
    if (timer) clearInterval(timer);
    res.removeListener("close", disconnected);
    if (input && running.get(input.requestId) === controller) running.delete(input.requestId);
    if (reserved && input) await db.execute("UPDATE conversations SET active_request_id = NULL, active_until = NULL WHERE id = ? AND active_request_id = ?", [input.conversationId, token]).catch(() => undefined);
  }
}
