import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { usedCitations } from "../../shared/citations.ts";
import { KnowledgeSources } from "../../app/KnowledgeSources.tsx";
import { ChatView } from "../../app/App.tsx";

const candidates = [1, 2, 3].map((number) => ({
  documentId: `document-${number}`, title: `资料 ${number}`, filename: `source-${number}.txt`,
  chunkIndex: 0, excerpt: `片段 ${number}`, score: 0.8,
}));

test("retrieval candidates are hidden when the answer has no knowledge citations", () => {
  for (const answer of ["", "你好，有什么可以帮你？", "知识库中没有足够资料确认此问题，建议咨询负责人。", "参考来源：无"]) {
    assert.deepEqual(usedCitations(answer, candidates), []);
    assert.equal(renderToStaticMarkup(createElement(KnowledgeSources, { answer, citations: candidates })), "");
  }
});

test("only referenced candidates survive and keep their original numbers", () => {
  const sources = usedCitations("按审批流程办理。[2]\n参考来源：[2] [2] [99]", candidates);
  assert.deepEqual(sources, [{ ...candidates[1], referenceNumber: 2 }]);
  const html = renderToStaticMarkup(createElement(KnowledgeSources, { answer: "结论。[2]", citations: sources }));
  assert.match(html, /知识库来源/);
  assert.match(html, /<b>\[2\]<\/b>/);
  assert.match(html, /document-2\/download/);
  assert.doesNotMatch(html, /资料 1|资料 3|\[1\]/);
});

test("filtered and sparse citation lists remain stable across storage and repeated filtering", () => {
  const sparse = [{ ...candidates[0], referenceNumber: 4 }, { ...candidates[2], referenceNumber: 6 }];
  assert.deepEqual(usedCitations("[1] [3]", sparse), []);
  const once = usedCitations("结论。[6] [4]", sparse);
  assert.deepEqual(once, sparse);
  assert.deepEqual(usedCitations("结论。[6] [4]", JSON.parse(JSON.stringify(once))), once);
  assert.deepEqual(usedCitations("结论。[2]", candidates), [{ ...candidates[1], referenceNumber: 2 }]);
  assert.equal(candidates[1].referenceNumber, undefined, "Legacy candidate arrays must not be mutated");
});

test("Chinese brackets, grouped references and ranges resolve only available candidates", () => {
  for (const answer of ["来源：[1, 3] 【２】", "来源：［１，３］ [2]", "来源：[1][2][3]", "来源：[1–3]", "来源：[1-999999999]"]) {
    assert.deepEqual(usedCitations(answer, candidates).map((source) => source.referenceNumber), [1, 2, 3]);
  }
});

test("invalid references, code samples and Markdown links do not become knowledge sources", () => {
  for (const answer of [
    "[0] [-1] [01] [1.5] [3-1] [99999999999999999999999] [404]",
    "`[1]` 与 ``[2]`` 是代码。\n```js\n[3]\n```",
    "~~~text\n[1] [2]\n~~~\n```\n[3]",
    "[1](https://example.org)\n[2]: https://example.org\n\\[3]",
    "[[1]] 与 [^2] ![3]",
  ]) assert.deepEqual(usedCitations(answer, candidates), []);
  assert.deepEqual(usedCitations("```\n[1]\n```\n实际使用。[2]", candidates).map((source) => source.referenceNumber), [2]);
});

test("missing and invalid stored candidates never produce a source card", () => {
  assert.deepEqual(usedCitations("[1]"), []);
  assert.deepEqual(usedCitations("[1]", null), []);
  assert.deepEqual(usedCitations("[1]", [null]), []);
  assert.deepEqual(usedCitations("[1]", [{ ...candidates[0], referenceNumber: 0 }]), []);
});

const props = { question: "问题", setQuestion() {}, provider: "gemini", setProvider() {}, webSearch: false, setWebSearch() {}, sending: false, sendQuestion() {}, onRate() {} };

test("web-only answers show web sources without borrowing their numbers for the knowledge source list", () => {
  const html = renderToStaticMarkup(createElement(ChatView, { ...props, messages: [{
    id: "web-only", role: "assistant", content: "知识库中没有足够资料确认此问题。", citations: candidates, webSearch: true,
    webResult: { searched: true, text: "公开资料说明。[1]", sources: [{ title: "公开网站", url: "https://example.org/" }] },
  }] }));
  assert.doesNotMatch(html, /知识库来源|document-1\/download/);
  assert.match(html, /网页来源|公开网站/);
  assert.match(html, /href="https:\/\/example.org\/"/);
});

test("chat hides knowledge sources until the answer completes and displays only the used card", () => {
  const message = { id: "answer", role: "assistant", content: "实际结论。[3]", citations: candidates };
  const pending = renderToStaticMarkup(createElement(ChatView, { ...props, messages: [{ ...message, pending: true }] }));
  assert.doesNotMatch(pending, /知识库来源/);
  const complete = renderToStaticMarkup(createElement(ChatView, { ...props, messages: [message] }));
  assert.match(complete, /<b>\[3\]<\/b>/);
  assert.match(complete, /document-3\/download/);
  assert.doesNotMatch(complete, /资料 1|资料 2/);
});
