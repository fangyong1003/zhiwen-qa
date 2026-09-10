import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as XLSX from "xlsx";
import { validateAttachmentBytes } from "../../server/file-validation.ts";
import { AttachmentTray } from "../../app/AttachmentTray.tsx";
import { KnowledgeSources } from "../../app/KnowledgeSources.tsx";
import { ChatView } from "../../app/App.tsx";

test("private files validate their real format and reject binary TXT or unsupported extensions", () => {
  validateAttachmentBytes(Buffer.from("有效 UTF-8 文本"), "资料.TXT");
  assert.throws(() => validateAttachmentBytes(Buffer.from("not a PDF"), "fake.pdf"));
  assert.throws(() => validateAttachmentBytes(Buffer.from([0xff]), "invalid.txt"));
  assert.throws(() => validateAttachmentBytes(Buffer.from([0]), "binary.txt"));
  assert.throws(() => validateAttachmentBytes(Buffer.from("script"), "script.exe"));
  assert.throws(() => validateAttachmentBytes(Buffer.alloc(0), "empty.txt"));
  assert.throws(() => validateAttachmentBytes(Buffer.alloc(10 * 1024 * 1024 + 1), "large.txt"));
});

test("Office containers validate type and reject expansion bombs before parsing", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["项目", "金额"], ["报销", 300]]), "预算");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true });
  validateAttachmentBytes(bytes, "预算.xlsx");
  assert.throws(() => validateAttachmentBytes(bytes, "wrong.docx"), /格式与扩展名/);
  const bomb = Buffer.from(bytes);
  const offset = bomb.indexOf(Buffer.from("504b0102", "hex"));
  bomb.writeUInt32LE(40 * 1024 * 1024, offset + 24);
  assert.throws(() => validateAttachmentBytes(bomb, "bomb.xlsx"), /30 MB/);
});

test("attachment controls explain privacy, processing and source scope", () => {
  const html = renderToStaticMarkup(createElement(AttachmentTray, { attachments: [{ id: "file", filename: "合同.pdf", status: "indexing", size_bytes: 1000 }], scope: "attachments", disabled: false, uploading: false, onScope() {}, onUpload() {}, onDelete() {}, onRetry() {} }));
  assert.match(html, /仅本人当前会话可用/);
  assert.match(html, /不会加入共享知识库/);
  assert.match(html, /正在建立检索索引/);
  assert.match(html, /仅会话附件/);
});

test("private citations download through the conversation authorization boundary", () => {
  const html = renderToStaticMarkup(createElement(KnowledgeSources, { answer: "资料内容。[1]", citations: [{ source: "attachment", conversationId: "private-conversation", documentId: "private-file", title: "合同", filename: "合同.pdf", chunkIndex: 0, excerpt: "原文", score: 1 }] }));
  assert.match(html, /\/api\/conversations\/private-conversation\/attachments\/private-file\/download/);
  assert.doesNotMatch(html, /\/api\/documents\//);
});

test("compact attachment controls retain the current scope and failed-file warning", () => {
  const html = renderToStaticMarkup(createElement(AttachmentTray, { attachments: [{ id: "file", filename: "合同.pdf", status: "failed", size_bytes: 1000 }], scope: "attachments", compact: true, disabled: false, uploading: false, onScope() {}, onUpload() {}, onDelete() {}, onRetry() {} }));
  assert.match(html, /仅会话附件 · 1 个附件 · 存在处理失败的附件/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /展开资料/);
});

test("failed partial answers have retry controls but never feedback or confirmed sources", () => {
  const html = renderToStaticMarkup(createElement(ChatView, { messages: [{ id: "failed", role: "assistant", content: "部分回答", turn: { id: "request", status: "failed", error_code: "search_failed", error_message: "联网搜索失败" } }], question: "", setQuestion() {}, provider: "gemini", setProvider() {}, webSearch: false, setWebSearch() {}, sending: false, sendQuestion() {}, onRate() {} }));
  assert.match(html, /重试此问题/);
  assert.match(html, /关闭联网并继续/);
  assert.match(html, /不会进入后续上下文/);
  assert.doesNotMatch(html, /有帮助|不准确/);
});
