import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canSendQuestion, isSendKey } from "../../app/composer.ts";
import { ChatView } from "../../app/App.tsx";
import { WebSearchResults } from "../../app/WebSearchResults.tsx";

const enter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, repeat: false };

test("Enter is a send action and Shift+Enter remains a newline", () => {
  assert.equal(isSendKey(enter, false), true);
  assert.equal(isSendKey({ ...enter, shiftKey: true }, false), false);
  assert.equal(isSendKey({ ...enter, key: "a" }, false), false);
});

test("IME composition and Safari candidate confirmation never send a message", () => {
  assert.equal(isSendKey({ ...enter, isComposing: true }, false), false);
  assert.equal(isSendKey(enter, true), false);
  assert.equal(isSendKey({ ...enter, keyCode: 229 }, false), false);
});

test("empty, too-short and in-flight questions cannot be sent", () => {
  for (const question of ["", " \n ", "问", " a "]) assert.equal(canSendQuestion(question, false), false);
  assert.equal(canSendQuestion(" 有效问题 ", false), true);
  assert.equal(canSendQuestion("有效问题", true), false);
});

const props = { messages: [], question: "问题", setQuestion() {}, provider: "gemini", setProvider() {}, webSearch: false, setWebSearch() {}, sending: false, sendQuestion() {}, onRate() {} };

test("search control is below the input and is unchecked by default", () => {
  const html = renderToStaticMarkup(createElement(ChatView, props));
  assert.ok(html.indexOf("</textarea>") < html.indexOf('type="checkbox"'));
  assert.match(html, /联网搜索/);
  assert.match(html, /Enter 发送 · Shift\+Enter 换行/);
  assert.doesNotMatch(html, /checked=""/);
});

test("search selection is explicit and locked while an answer is in flight", () => {
  const html = renderToStaticMarkup(createElement(ChatView, { ...props, webSearch: true, sending: true }));
  assert.match(html, /type="checkbox"[^>]*disabled=""[^>]*checked=""/);
  assert.match(html, /请勿输入机密内容/);
  assert.match(html, /<select disabled=""/);
});

test("web citations reject unsafe URLs and search suggestions cannot execute in the app origin", () => {
  const html = renderToStaticMarkup(createElement(WebSearchResults, { result: {
    searched: true, text: "公开资料。", sources: [{ title: "安全来源", url: "https://example.org/" }, { title: "不安全来源", url: "javascript:alert(1)" }],
    searchSuggestions: "<script>parent.document.body.remove()</script><a href='https://www.google.com/'>Search</a>",
  } }));
  assert.match(html, /href="https:\/\/example.org\/"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /sandbox="allow-popups allow-popups-to-escape-sandbox"/);
  assert.doesNotMatch(html, /allow-scripts|allow-same-origin/);
  assert.doesNotMatch(html, /<script>/);
});

test("history explains why ephemeral search results are not stored", () => {
  const html = renderToStaticMarkup(createElement(ChatView, { ...props, messages: [{ id: "history", role: "assistant", content: "知识库回答", webSearch: true }] }));
  assert.match(html, /不保存到历史记录/);
});
