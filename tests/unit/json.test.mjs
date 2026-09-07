import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonColumn } from "../../server/json.ts";

test("mysql2 JSON arrays and audit objects are not parsed twice", () => {
  const citations = [{ documentId: "document-1", title: "差旅制度" }];
  const detail = { provider: "openai", sources: 1 };
  assert.strictEqual(parseJsonColumn(citations, []), citations);
  assert.strictEqual(parseJsonColumn(detail, null), detail);
  assert.deepEqual(parseJsonColumn([], []), []);
});

test("string JSON and nullable columns are supported", () => {
  assert.deepEqual(parseJsonColumn('[{"score":0.9}]', []), [{ score: 0.9 }]);
  assert.deepEqual(parseJsonColumn('{"rating":"up"}', null), { rating: "up" });
  for (const value of [null, undefined, "null"]) assert.deepEqual(parseJsonColumn(value, []), []);
  assert.throws(() => parseJsonColumn("invalid json", []), SyntaxError);
});
