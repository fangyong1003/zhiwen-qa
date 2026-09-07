import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = path.resolve("start.sh");

test("one-click startup script has valid Bash syntax and executable permissions", async () => {
  await run("bash", ["-n", script]);
  const { stdout } = await run(script, ["--help"], { cwd: os.tmpdir() });
  assert.match(stdout, /MySQL/);
  assert.match(stdout, /Ctrl\+C/);
  assert.match(stdout, /--check/);
});

test("startup script rejects unknown arguments before doing any setup", async () => {
  await assert.rejects(run("bash", [script, "--invalid"], { cwd: os.tmpdir() }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /未知参数/);
    assert.doesNotMatch(error.stdout, /npm|初始化|正在启动/);
    return true;
  });
});
