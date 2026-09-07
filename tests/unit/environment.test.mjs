import assert from "node:assert/strict";
import test from "node:test";
import { readEnvironment } from "../../server/environment.ts";

const required = { MYSQL_URL: "mysql://fixture@127.0.0.1/zhiwen_test", JWT_SECRET: "unit-test-secret-with-at-least-32-characters" };

test("blank optional settings from the template do not block startup", () => {
  const env = readEnvironment({ ...required, OPENAI_API_KEY: "", DEEPSEEK_API_KEY: " ", GEMINI_API_KEY: "", GEMINI_BASE_URL: "", GEMINI_CHAT_MODEL: "", ADMIN_EMAIL: "", ADMIN_PASSWORD: "", OPENAI_CHAT_MODEL: "", ADMIN_NAME: "" });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.GEMINI_BASE_URL, undefined);
  assert.equal(env.GEMINI_CHAT_MODEL, "gemini-3.8-flash");
  assert.equal(env.ADMIN_EMAIL, undefined);
  assert.equal(env.ADMIN_PASSWORD, undefined);
  assert.ok(env.OPENAI_CHAT_MODEL);
  assert.equal(env.ADMIN_NAME, "系统管理员");
});

test("Gemini model and endpoint can be configured without accepting invalid URLs", () => {
  const env = readEnvironment({ ...required, GEMINI_CHAT_MODEL: "gemini-custom", GEMINI_BASE_URL: "http://127.0.0.1:12345" });
  assert.equal(env.GEMINI_CHAT_MODEL, "gemini-custom");
  assert.equal(env.GEMINI_BASE_URL, "http://127.0.0.1:12345");
  for (const url of ["invalid", "file:///tmp/fixture"]) assert.throws(() => readEnvironment({ ...required, GEMINI_BASE_URL: url }));
});

test("database credentials, signing secret and valid port are still required", () => {
  assert.throws(() => readEnvironment({}));
  assert.throws(() => readEnvironment({ ...required, JWT_SECRET: "too-short" }));
  for (const PORT of ["0", "65536", "1.5", "invalid"]) assert.throws(() => readEnvironment({ ...required, PORT }));
});

test("administrator bootstrap requires both email and password", () => {
  assert.throws(() => readEnvironment({ ...required, ADMIN_EMAIL: "admin@example.invalid" }));
  assert.throws(() => readEnvironment({ ...required, ADMIN_PASSWORD: "test-password-long" }));
  assert.equal(readEnvironment({ ...required, ADMIN_EMAIL: "admin@example.invalid", ADMIN_PASSWORD: "test-password-long" }).ADMIN_EMAIL, "admin@example.invalid");
});
