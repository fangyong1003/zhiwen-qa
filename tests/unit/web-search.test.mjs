import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { searchWeb } from "../../server/web-search.ts";
import { safeWebUrl } from "../../shared/web-search.ts";
import { googleSearchResponse } from "../helpers/gemini.mjs";

async function fixture(t, mode = "success") {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    requests.push({ url: req.url, key: req.headers["x-goog-api-key"], body: JSON.parse(body) });
    googleSearchResponse(res, mode);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { requests, settings: { apiKey: "fixture-search-key", model: "fixture-gemini", baseUrl: `http://127.0.0.1:${server.address().port}` } };
}

test("web search enables the real Google SDK tool with only the current question", async (t) => {
  const { requests, settings } = await fixture(t);
  const result = await searchWeb(settings, "公开资料问题？");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/models\/fixture-gemini:generateContent$/);
  assert.equal(requests[0].key, "fixture-search-key");
  assert.deepEqual(requests[0].body.tools, [{ googleSearch: {} }]);
  assert.deepEqual(requests[0].body.contents, [{ role: "user", parts: [{ text: "公开资料问题？" }] }]);
  assert.equal(result.searched, true);
  assert.equal(result.text, "公开网页说明：请查阅官方公布的最新资料。");
  assert.deepEqual(result.sources, [{ url: "https://example.org/public-guide", title: "公开资料指南" }, { url: "https://example.net/reference", title: "example.net" }]);
  assert.match(result.searchSuggestions, /Google 搜索建议/);
  assert.doesNotMatch(result.text, /thought/);
});

test("ungrounded output is not presented as a web-search answer", async (t) => {
  const { settings } = await fixture(t, "ungrounded");
  assert.deepEqual(await searchWeb(settings, "问题"), { searched: false, text: "", sources: [] });
});

test("missing Gemini search credentials fail before making a request", async () => {
  await assert.rejects(searchWeb({ model: "fixture" }, "问题"), /GEMINI_API_KEY/);
});

for (const [mode, expected] of [["blocked", /未能完成/], ["empty", /未返回内容/], ["truncated", /未能完成/], [400, /模型或工具不可用/], [403, /身份验证失败/], [404, /模型或工具不可用/], [429, /额度或频率/], [500, /HTTP 500/]]) {
  test(`web search handles ${mode} without exposing upstream details`, async (t) => {
    const { settings } = await fixture(t, mode);
    await assert.rejects(searchWeb(settings, "问题"), (error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /Fixture search secret/);
      return true;
    });
  });
}

test("web source links only allow credential-free HTTP(S) URLs", () => {
  for (const url of [undefined, "", "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "/relative", "https://name:password@example.com"]) {
    assert.equal(safeWebUrl(url), null);
  }
  assert.equal(safeWebUrl("https://example.org/guide?q=test"), "https://example.org/guide?q=test");
});
