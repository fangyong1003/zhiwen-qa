import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { submitFeedback } from "../../app/feedback.ts";
import { MessageFeedback } from "../../app/MessageFeedback.tsx";
import { ChatView } from "../../app/App.tsx";

test("feedback is saved only after the server confirms success", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  assert.equal(await submitFeedback("answer-1", "up"), "up");
  assert.equal(request.mock.callCount(), 1);
  const [url, options] = request.mock.calls[0].arguments;
  assert.equal(url, "/api/feedback");
  assert.equal(options.method, "POST");
  assert.equal(options.credentials, "include");
  assert.deepEqual(JSON.parse(options.body), { messageId: "answer-1", rating: "up" });
  assert.ok(options.signal instanceof AbortSignal);
});

test("a duplicate response restores the original choice rather than overwriting it", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "已经评价", rating: "up" }, { status: 409 }));
  assert.equal(await submitFeedback("answer-1", "down"), "up");
});

test("a failed or unconfirmed response does not report a saved rating", async (t) => {
  const request = t.mock.method(globalThis, "fetch");
  for (const response of [
    Response.json({ error: "评价服务暂时不可用，请重试。" }, { status: 503 }),
    Response.json({ error: "该回答已评价，请刷新。", rating: "invalid" }, { status: 409 }),
    new Response("invalid", { status: 500 }),
  ]) {
    request.mock.mockImplementation(async () => response);
    await assert.rejects(submitFeedback("answer-1", "down"), /评价/);
  }
});

test("network failures remain retryable without assuming that the server failed to save", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async () => { throw new Error("Connection lost"); });
  await assert.rejects(submitFeedback("answer-1", "up"), /未能确认评价结果/);
  request.mock.mockImplementation(async () => Response.json({ rating: "up" }, { status: 409 }));
  assert.equal(await submitFeedback("answer-1", "down"), "up");
});

test("new feedback controls expose two available choices and a live status", () => {
  const html = renderToStaticMarkup(createElement(MessageFeedback, { messageId: "new", onRate: async (_id, value) => value }));
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /disabled=""|已评价/);
  assert.match(html, /role="status"/);
  assert.match(html, /评价这条回答/);
});

for (const rating of ["up", "down"]) {
  test(`a saved ${rating} rating locks both choices and highlights the selected one`, () => {
    const html = renderToStaticMarkup(createElement(MessageFeedback, { messageId: "saved", rating, onRate: async (_id, value) => value }));
    assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
    assert.match(html, new RegExp(`class="selected"[^>]*aria-pressed="true"[^>]*>${rating === "up" ? "✓ 有帮助" : "× 不准确"}`));
    assert.match(html, /已评价 · 每条回答仅可评价一次/);
  });
}

test("history restores saved feedback without disabling answer copying", () => {
  const html = renderToStaticMarkup(createElement(ChatView, {
    messages: [{ id: "saved", role: "assistant", content: "回答", feedback: "down" }],
    question: "问题", setQuestion() {}, provider: "gemini", setProvider() {}, webSearch: false, setWebSearch() {}, sending: false, sendQuestion() {}, onRate: async (_id, value) => value,
  }));
  assert.match(html, /已评价/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.match(html, /<button>复制知识库回答<\/button>/);
});
