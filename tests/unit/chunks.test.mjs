import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const moduleUrl = new URL("../../server/chunks.ts", import.meta.url).href;

// Run in a child process so a regression to a synchronous infinite loop is actually interrupted.
async function split(input, size = 1000, overlap = 160) {
  const script = `import { splitText } from ${JSON.stringify(moduleUrl)};
    const args = JSON.parse(process.argv[1]);
    try { console.log(JSON.stringify({ chunks: splitText(...args) })); }
    catch (error) { console.log(JSON.stringify({ error: error.name })); }`;
  const { stdout } = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify([input, size, overlap])], { timeout: 5000 });
  return JSON.parse(stdout);
}

test("empty and short documents terminate without duplicate tails", async () => {
  assert.deepEqual((await split(" \r\n ")).chunks, []);
  for (const length of [20, 160, 1000]) {
    const text = "知".repeat(length);
    assert.deepEqual((await split(text)).chunks, [text]);
  }
});

test("long documents retain all content and the configured overlap", async () => {
  const text = Array.from({ length: 2500 }, (_, index) => String.fromCharCode(0x4e00 + index)).join("");
  const { chunks } = await split(text);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 1000));
  assert.equal(chunks[0] + chunks.slice(1).map((chunk) => chunk.slice(160)).join(""), text);
});

test("natural breaks respect the size limit and retain the final paragraph", async () => {
  const { chunks } = await split(`${"甲".repeat(60)}。${"乙".repeat(120)}\n最后一段`, 100, 20);
  assert.equal(chunks[0], `${"甲".repeat(60)}。`);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
  assert.ok(chunks.at(-1).endsWith("最后一段"));
  assert.equal((await split("abcdefghijklmnop", 5, 0)).chunks.join(""), "abcdefghijklmnop");
});

test("invalid chunk settings fail instead of looping", async () => {
  for (const [size, overlap] of [[0, 0], [1.5, 0], [5, -1], [5, 5], [5, 1.5]]) {
    assert.equal((await split("abc", size, overlap)).error, "RangeError");
  }
});
