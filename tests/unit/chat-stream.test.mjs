import assert from "node:assert/strict";
import test from "node:test";
import { newRequestId, readChatEvents } from "../../app/chat-stream.ts";

test("request identifiers are UUIDs without depending on secure-context randomUUID", () => {
  const ids = new Set(Array.from({ length: 100 }, () => newRequestId()));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
});

test("SSE parsing survives split UTF-8, CRLF, progress and final metadata", async () => {
  const bytes = new TextEncoder().encode('event: progress\r\ndata: {"label":"检索中"}\r\n\r\nevent: delta\r\ndata: {"text":"你好🙂"}\r\n\r\nevent: done\r\ndata: {"messageId":"saved"}\r\n\r\n');
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const events = [];
  await readChatEvents(new Response(stream), (type, data) => events.push({ type, data }));
  assert.equal(events[1].data.text, "你好🙂");
  assert.equal(events.at(-1).type, "done");
});

test("a closed stream without a terminal event fails and exposes a retryable state", async () => {
  await assert.rejects(readChatEvents(new Response('event: delta\ndata: {"text":"partial"}\n\n'), () => undefined), /连接中断/);
});

test("cancelled and failed streams finish without being mistaken for a completed answer", async () => {
  for (const type of ["cancelled", "error"]) {
    const events = [];
    await readChatEvents(new Response(`event: ${type}\ndata: {"error":"未完成"}\n\n`), (event) => events.push(event));
    assert.deepEqual(events, [type]);
  }
});
