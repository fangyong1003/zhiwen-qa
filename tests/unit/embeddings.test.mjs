import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { cosineSimilarity, createGeminiEmbeddings, embeddingSpace, isEmbeddingVector } from "../../server/embeddings.ts";
import { geminiEmbeddingResponse } from "../helpers/gemini.mjs";

async function fixture(t, mode = "success") {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const input = JSON.parse(body);
    requests.push({ url: req.url, key: req.headers["x-goog-api-key"], input });
    geminiEmbeddingResponse(res, input, mode);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { requests, settings: { apiKey: "fixture-gemini-key", model: "gemini-embedding-2", dimensions: 768, baseUrl: `http://127.0.0.1:${server.address().port}` } };
}

test("Gemini Embedding 2 keeps each document chunk separate across batches using the actual SDK", async (t) => {
  const { requests, settings } = await fixture(t);
  const texts = Array.from({ length: 65 }, (_, index) => `报销规定片段 ${index}`);
  const vectors = await createGeminiEmbeddings(settings, texts, "document");
  assert.equal(vectors.length, 65);
  assert.deepEqual(requests.map((request) => request.input.requests.length), [64, 1]);
  const inputs = requests.flatMap((request) => request.input.requests);
  assert.deepEqual(inputs.map((input) => input.content.parts[0].text), texts.map((text) => `title: none | text: ${text}`));
  for (const request of requests) {
    assert.match(request.url, /\/models\/gemini-embedding-2:batchEmbedContents$/);
    assert.equal(request.key, "fixture-gemini-key");
  }
  for (const [index, vector] of vectors.entries()) {
    assert.equal(vector.length, 768);
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-12);
    const lengthValue = inputs[index].content.parts[0].text.length / 100;
    assert.ok(Math.abs(vector[2] - lengthValue / Math.hypot(1, 1, lengthValue)) < 1e-12);
    assert.equal(inputs[index].outputDimensionality, 768);
    assert.equal(inputs[index].taskType, undefined);
  }
});

test("question vectors use the question-answering prefix with the same model and dimensions", async (t) => {
  const { requests, settings } = await fixture(t);
  await createGeminiEmbeddings(settings, ["报销需要什么材料？"], "query");
  const input = requests[0].input.requests[0];
  assert.equal(input.content.parts[0].text, "task: question answering | query: 报销需要什么材料？");
  assert.equal(input.model, "models/gemini-embedding-2");
  assert.equal(input.outputDimensionality, 768);
  assert.equal(input.taskType, undefined);
});

test("Gemini Embedding 001 uses retrieval task types instead of Embedding 2 prefixes", async (t) => {
  const { requests, settings } = await fixture(t);
  settings.model = "gemini-embedding-001";
  await createGeminiEmbeddings(settings, ["报销规定", "第二份规定"], "document");
  await createGeminiEmbeddings(settings, ["报销资料？"], "query");
  assert.deepEqual(requests[0].input.requests.map((input) => input.content.parts[0].text), ["报销规定", "第二份规定"]);
  assert.ok(requests[0].input.requests.every((input) => input.taskType === "RETRIEVAL_DOCUMENT"));
  assert.equal(requests[1].input.requests[0].taskType, "QUESTION_ANSWERING");
  assert.equal(requests[1].input.requests[0].content.parts[0].text, "报销资料？");
});

test("empty input and missing Gemini key make no model requests", async (t) => {
  const { requests, settings } = await fixture(t);
  assert.deepEqual(await createGeminiEmbeddings(settings, [], "document"), []);
  await assert.rejects(createGeminiEmbeddings({ ...settings, apiKey: undefined }, ["问题"], "query"), /GEMINI_API_KEY/);
  assert.equal(requests.length, 0);
});

for (const [mode, error] of [
  ["wrong-count", /向量数量/], ["wrong-dimensions", /维度不正确/], ["invalid-values", /向量无效/], ["zero-vector", /向量无效/], ["missing-vector", /向量无效/],
  [400, /参数无效/], [403, /身份验证失败/], [404, /GEMINI_EMBEDDING_MODEL/], [429, /额度或频率/],
]) {
  test(`embedding ${mode} is rejected without exposing upstream internals`, async (t) => {
    const { settings } = await fixture(t, mode);
    await assert.rejects(createGeminiEmbeddings(settings, ["报销资料"], "document"), (failure) => {
      assert.match(failure.message, error);
      assert.doesNotMatch(failure.message, /Fixture|fixture-gemini-key/);
      return true;
    });
  });
}

test("embedding compatibility includes the model, dimensions and retrieval format", () => {
  const space = embeddingSpace({ model: "gemini-embedding-2", dimensions: 768 });
  assert.equal(space, "gemini:gemini-embedding-2:768:qa-v1");
  assert.notEqual(space, embeddingSpace({ model: "gemini-embedding-001", dimensions: 768 }));
  assert.notEqual(space, embeddingSpace({ model: "gemini-embedding-2", dimensions: 1536 }));
});

test("cosine similarity never truncates mismatched or invalid vectors", () => {
  assert.equal(cosineSimilarity([1, 0], [2, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  for (const values of [[1], [0, 0], [NaN, 1], [Infinity, 1], ["1", 1], [], null, {}]) {
    assert.equal(isEmbeddingVector(values, 2), false);
    if (Array.isArray(values)) assert.throws(() => cosineSimilarity([1, 0], values), /向量数据/);
  }
});
