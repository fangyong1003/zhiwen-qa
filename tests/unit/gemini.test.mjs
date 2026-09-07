import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { streamGeminiAnswer } from "../../server/gemini.ts";
import { geminiResponse } from "../helpers/gemini.mjs";

async function fixture(t, mode = "success") {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    requests.push({ url: req.url, key: req.headers["x-goog-api-key"], body: JSON.parse(body) });
    geminiResponse(res, mode);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { requests, settings: { apiKey: "fixture-gemini-key", model: "fixture-gemini", baseUrl: `http://127.0.0.1:${server.address().port}` } };
}

test("Gemini streams answer text and maps history through the actual Google SDK", async (t) => {
  const { requests, settings } = await fixture(t);
  const deltas = [];
  const history = [{ role: "user", content: "报销材料？" }, { role: "assistant", content: "发票与审批单。" }];
  const answer = await streamGeminiAnswer(settings, "谁审核？", history, "只使用共享知识库中的制度。", (delta) => deltas.push(delta));
  assert.equal(answer, "Gemini：报销需要发票和审批单。\n参考来源：[1]");
  assert.equal(deltas.join(""), answer);
  assert.equal(deltas.length, 2);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/models\/fixture-gemini:streamGenerateContent\?alt=sse$/);
  assert.equal(requests[0].key, "fixture-gemini-key");
  assert.deepEqual(requests[0].body.contents.map((message) => message.role), ["user", "model", "user"]);
  assert.equal(requests[0].body.contents[1].parts[0].text, "发票与审批单。");
  assert.equal(requests[0].body.contents.at(-1).parts[0].text, "谁审核？");
  assert.equal(requests[0].body.systemInstruction.parts[0].text, "只使用共享知识库中的制度。");
});

test("Gemini history is bounded and drops a leading orphan assistant turn", async (t) => {
  const { requests, settings } = await fixture(t);
  const history = Array.from({ length: 7 }, (_, index) => ({ role: index % 2 === 0 ? "assistant" : "user", content: `历史 ${index}` }));
  await streamGeminiAnswer(settings, "继续", history, "资料", () => undefined);
  assert.equal(requests[0].body.contents.length, 7);
  assert.equal(requests[0].body.contents[0].role, "user");
  assert.equal(requests[0].body.contents[0].parts[0].text, "历史 1");
  assert.equal(history.length, 7);
});

test("missing Gemini key fails before a network request", async () => {
  await assert.rejects(streamGeminiAnswer({ model: "fixture" }, "问题", [], "资料", () => undefined), /GEMINI_API_KEY/);
});

for (const [mode, error] of [["blocked", /未能处理/], ["empty", /未返回文本/], ["interrupted", /响应中断/], ["truncated", /长度上限/], [403, /身份验证失败/], [404, /模型不可用/], [429, /额度或频率/]]) {
  test(`Gemini ${mode} is reported as failure instead of a completed answer`, async (t) => {
    const { settings } = await fixture(t, mode);
    await assert.rejects(streamGeminiAnswer(settings, "问题", [], "资料", () => undefined), error);
  });
}
