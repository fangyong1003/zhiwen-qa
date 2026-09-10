// Browser-only QA fixture: no business database, model credentials, or external search calls.
// Run explicitly with: node tests/helpers/chat-ui-fixture.mjs
import { randomUUID } from "node:crypto";
import express from "express";
import multer from "multer";
import { createServer } from "vite";

const app = express();
app.use(express.json());
const calls = [];
const feedbackCalls = [];
const failedFeedback = new Set();
const conversations = new Map();
const turns = new Map();
const files = new Map();
const streams = new Map();
app.get("/api/setup", (_req, res) => res.json({ needsSetup: false }));
app.get("/api/auth/me", (_req, res) => res.json({ user: { id: 1, email: "preview@example.invalid", displayName: "预览用户", role: "employee" } }));
app.get("/api/conversations", (_req, res) => res.json({ conversations: [...conversations.values()].map(({ id, title, updated_at }) => ({ id, title, updated_at })) }));
app.post("/api/conversations", (req, res) => {
  const id = req.body.id || randomUUID();
  if (!conversations.has(id)) conversations.set(id, { id, title: "新对话", updated_at: new Date().toISOString(), messages: [] });
  res.status(201).json({ conversation: { id } });
});
app.get("/api/conversations/:id", (req, res) => res.json({ messages: conversations.get(req.params.id)?.messages ?? [] }));
app.get("/api/conversations/:id/turns", (req, res) => res.json({ turns: [...turns.values()].filter((turn) => turn.request.conversationId === req.params.id), compressed: (conversations.get(req.params.id)?.messages.length ?? 0) > 8 }));
app.get("/api/conversations/:id/attachments", (req, res) => res.json({ attachments: files.get(req.params.id) ?? [] }));
app.post("/api/conversations/:id/attachments", multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single("file"), (req, res) => {
  const attachment = { id: randomUUID(), filename: req.file.originalname, size_bytes: req.file.size, status: "parsing" };
  files.set(req.params.id, [...(files.get(req.params.id) ?? []), attachment]);
  res.status(202).json({ attachment });
  setTimeout(() => { attachment.status = "ready"; attachment.chunk_count = 2; }, 1200);
});
app.delete("/api/conversations/:id/attachments/:fileId", (req, res) => {
  files.set(req.params.id, (files.get(req.params.id) ?? []).filter((file) => file.id !== req.params.fileId));
  res.sendStatus(204);
});
app.post("/api/chat/turns/:id/cancel", (req, res) => {
  const turn = turns.get(req.params.id);
  if (!turn) return res.status(404).json({ error: "问题不存在。" });
  if (turn.status === "running") {
    turn.status = "cancelled";
    turn.error_message = "已停止生成，可重试。";
    streams.get(turn.id)?.cancel();
  }
  res.json({ status: turn.status });
});
app.get("/api/fixture-state", (_req, res) => res.json({ calls, feedbackCalls, turns: [...turns.values()], conversations: [...conversations.values()] }));
app.post("/api/feedback", (req, res) => {
  feedbackCalls.push(req.body);
  const message = [...conversations.values()].flatMap((conversation) => conversation.messages).find((item) => item.id === req.body.messageId && item.role === "assistant");
  if (!message) return res.status(404).json({ error: "回答不存在。" });
  if (!["up", "down"].includes(req.body.rating)) return res.status(400).json({ error: "评价无效。" });
  setTimeout(() => {
    if (message.feedback) return res.status(409).json({ error: "该回答已评价，每条回答只能评价一次。", rating: message.feedback });
    if (message.failFeedbackOnce && !failedFeedback.has(message.id)) {
      failedFeedback.add(message.id);
      return res.status(503).json({ error: "评价暂时未能保存，请重试。" });
    }
    message.feedback = req.body.rating;
    res.sendStatus(204);
  }, 800);
});
app.post("/api/chat/stream", (req, res) => {
  calls.push(req.body);
  console.log(JSON.stringify({ fixtureQuestion: req.body.question, webSearch: req.body.webSearch, provider: req.body.provider }));
  const id = req.body.conversationId || randomUUID();
  const conversation = conversations.get(id) ?? { id, title: req.body.question, updated_at: new Date().toISOString(), messages: [] };
  const messageId = randomUUID();
  // Include “无引用” in a question to preview an answer without knowledge sources.
  const noCitations = req.body.question.includes("无引用");
  const content = noCitations ? "知识库中没有足够资料确认此问题。此处是无引用回答的界面演示。" : "这是隔离预览中的资料回答，不代表实际业务规定。\n\n1. 在所选资料中查找相关制度与流程。\n2. 核对资料中的适用范围，并通过下方引用查看原文。[2]\n3. 如需了解公开资料，可在输入框下方开启联网搜索。\n\n该页面不会查询实际数据库或调用模型。\n参考来源：[2]";
  const citations = noCitations ? [] : [{ documentId: "preview-document", chunkIndex: 0, title: "员工资料查询指南（界面演示）", filename: "preview.txt", excerpt: "此处为引用片段的展示示例，用于检查长内容的截断、换行和卡片布局。仅供界面测试，不是实际知识库资料。", score: 1, referenceNumber: 2 }];
  const attachment = (files.get(id) ?? []).find((file) => req.body.attachmentIds?.includes(file.id));
  if (attachment && citations.length) Object.assign(citations[0], { documentId: attachment.id, filename: attachment.filename, title: attachment.filename, source: "attachment", conversationId: id });
  const webResult = req.body.webSearch ? {
    searched: true,
    text: "这是联网补充的展示样例。实际使用时，Google 搜索会返回当前问题的公开资料及来源。",
    sources: [{ title: "公开资料示例", url: "https://example.org/public-guide" }],
    searchSuggestions: '<a href="https://www.google.com/search?q=public+guide" style="display:block;padding:16px;color:#1f7463;font:14px Arial">Google 搜索建议 · 公开资料</a>',
  } : undefined;
  const requestId = req.body.requestId || randomUUID();
  const previous = turns.get(requestId);
  if (previous?.status === "running") return res.status(409).json({ error: "此问题正在生成。" });
  const userId = previous?.user_message_id || randomUUID();
  const turn = { id: requestId, user_message_id: userId, status: "running", partial_content: "", request: req.body };
  turns.set(requestId, turn);
  if (!previous) conversation.messages.push({ id: userId, role: "user", content: req.body.question, webSearch: req.body.webSearch });
  conversation.title = req.body.question;
  conversations.set(id, conversation);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  send("meta", { requestId, conversationId: id, userMessageId: userId });
  send("progress", { label: attachment ? "正在检索附件…" : "正在检索知识库…" });
  send("context", { compressed: conversation.messages.length > 8 });
  if (req.body.webSearch && req.body.question.includes("联网失败")) {
    turn.status = "failed";
    turn.error_code = "search_failed";
    turn.error_message = "联网搜索额度或频率已达上限，请稍后重试或关闭联网搜索。";
    send("error", { error: turn.error_message, code: turn.error_code, canContinueWithoutSearch: true });
    res.end();
    return;
  }
  const partial = content.slice(0, 22);
  turn.partial_content = partial;
  send("delta", { text: partial });
  const timer = setTimeout(() => {
    if (turn.status !== "running") return;
    send("sources", { citations: [], webResult, webSearch: req.body.webSearch });
    send("delta", { text: content.slice(partial.length) });
    conversation.messages.push({ id: messageId, role: "assistant", content, citations, webSearch: req.body.webSearch, feedback: null, failFeedbackOnce: req.body.question.includes("评价失败") });
    turn.status = "completed";
    turn.assistant_message_id = messageId;
    turn.partial_content = "";
    send("done", { conversationId: id, messageId, citations, webResult, webSearch: req.body.webSearch });
    res.end();
    streams.delete(requestId);
  }, req.body.question.includes("慢速") ? 12000 : 1500);
  streams.set(requestId, { cancel() { clearTimeout(timer); send("cancelled", { error: turn.error_message }); res.end(); streams.delete(requestId); } });
  res.on("close", () => { if (turn.status === "running") { clearTimeout(timer); turn.status = "cancelled"; turn.error_message = "连接已中断，可重试。"; streams.delete(requestId); } });
});
app.use("/api", (_req, res) => res.status(404).json({ error: "Unknown fixture route" }));
const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "spa" });
app.use(vite.middlewares);
const server = app.listen(0, "127.0.0.1", () => console.log(`UI fixture: http://127.0.0.1:${server.address().port}`));
async function shutdown() {
  await vite.close();
  server.closeAllConnections();
  server.close();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
