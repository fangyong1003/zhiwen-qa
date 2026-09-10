import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { streamDeepSeekAnswer } from "../../server/deepseek.ts";
import { deepSeekAnswer, deepSeekResponse } from "../helpers/deepseek.mjs";

async function fixture(t, mode = "success") {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
    deepSeekResponse(res, mode);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { requests, settings: { apiKey: "fixture-deepseek-key", model: "fixture-deepseek", baseUrl: `http://127.0.0.1:${server.address().port}` } };
}

test("DeepSeek uses documented Chat Completions streaming, bearer auth and knowledge context", async (t) => {
  const { requests, settings } = await fixture(t);
  const history = [{ role: "user", content: "报销材料？" }, { role: "assistant", content: "发票。", reasoning_content: "must not forward" }];
  const deltas = [];
  const answer = await streamDeepSeekAnswer(settings, "谁审核？", history, "只依据公司资料回答。[1] 财务审核。", (delta) => deltas.push(delta));
  assert.equal(answer, deepSeekAnswer);
  assert.equal(deltas.join(""), answer);
  assert.equal(deltas.length, 2);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, "/chat/completions");
  assert.equal(request.authorization, "Bearer fixture-deepseek-key");
  assert.equal(request.body.model, "fixture-deepseek");
  assert.equal(request.body.stream, true);
  assert.deepEqual(request.body.thinking, { type: "disabled" });
  assert.equal(request.body.max_tokens, 4096);
  assert.deepEqual(request.body.messages, [
    { role: "system", content: "只依据公司资料回答。[1] 财务审核。" },
    { role: "user", content: "报销材料？" }, { role: "assistant", content: "发票。" }, { role: "user", content: "谁审核？" },
  ]);
  assert.ok(!answer.includes("reasoning"));
});

test("DeepSeek bounds history, removes orphan assistant turns and accepts a /v1 base URL", async (t) => {
  const { requests, settings } = await fixture(t);
  const history = Array.from({ length: 11 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `历史 ${index}` }));
  await streamDeepSeekAnswer({ ...settings, baseUrl: `${settings.baseUrl}/v1` }, "继续", history, "资料", () => undefined);
  assert.equal(requests[0].url, "/v1/chat/completions");
  assert.equal(requests[0].body.messages.length, 9);
  assert.equal(requests[0].body.messages[1].content, "历史 4");
  assert.equal(requests[0].body.messages.at(-1).content, "继续");
  assert.equal(history.length, 11);
});

test("missing DeepSeek key fails before any HTTP request", async (t) => {
  const { requests, settings } = await fixture(t);
  await assert.rejects(streamDeepSeekAnswer({ ...settings, apiKey: undefined }, "问题", [], "资料", () => undefined), /DEEPSEEK_API_KEY/);
  assert.equal(requests.length, 0);
});

for (const [mode, expected] of [
  ["empty", /未返回文本/], ["interrupted", /响应中断/], ["length", /长度上限/], ["content_filter", /未能处理/],
  ["insufficient_system_resource", /推理资源不足/], ["tool_calls", /未能完成文本回答/],
  ["stream_error", /响应异常或连接中断/], ["malformed", /响应异常或连接中断/],
  [400, /模型或请求参数/], [401, /身份验证失败/], [402, /账户余额不足/], [403, /身份验证失败/],
  [404, /模型或请求参数/], [422, /模型或请求参数/], [429, /频率或 Token/], [500, /HTTP 500/], [503, /服务繁忙/],
]) {
  test(`DeepSeek ${mode} fails safely without exposing provider details or retrying`, async (t) => {
    const { requests, settings } = await fixture(t, mode);
    await assert.rejects(streamDeepSeekAnswer(settings, "问题", [], "资料", () => undefined), (error) => {
      assert.match(error.message, expected);
      assert.ok(!error.message.includes("Fixture private"));
      assert.ok(!error.message.includes(settings.apiKey));
      return true;
    });
    assert.equal(requests.length, 1);
  });
}
