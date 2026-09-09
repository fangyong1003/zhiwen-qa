import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import mysql from "mysql2/promise";
import { geminiEmbeddingResponse, geminiResponse } from "../helpers/gemini.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("MySQL-backed knowledge QA API", { timeout: 90000 }, async (t) => {
  assert.ok(process.env.TEST_MYSQL_URL, "Set TEST_MYSQL_URL to an isolated MySQL server, or run npm run test:integration:local");
  const endpoint = new URL(process.env.TEST_MYSQL_URL);
  assert.equal(endpoint.protocol, "mysql:");
  assert.ok(!endpoint.pathname || endpoint.pathname === "/" || /^\/zhiwen_test(?:_|$)/.test(endpoint.pathname), "Only zhiwen_test database prefixes are allowed");
  endpoint.pathname = "/";
  const bootstrap = await mysql.createConnection({ uri: endpoint.toString(), multipleStatements: false });
  const databaseName = `zhiwen_test_${randomUUID().replaceAll("-", "")}`;
  let databaseCreated = false;
  let uploadDir;
  let db;
  let apiServer;
  let modelServer;
  t.after(async () => {
    try {
      await closeServer(apiServer);
      await db?.end();
      await closeServer(modelServer);
      if (databaseCreated) await bootstrap.query(`DROP DATABASE \`${databaseName}\``);
    } finally {
      await bootstrap.end();
      if (uploadDir) await fs.rm(uploadDir, { recursive: true, force: true });
    }
  });

  await bootstrap.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4`);
  databaseCreated = true;
  endpoint.pathname = `/${databaseName}`;
  uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "zhiwen-api-test-"));

  // Exercise the real SDK, indexing, SQL and SSE handlers against a local protocol fixture.
  // These deterministic vectors and answers are not a model-quality evaluation.
  let rejectEmbeddings = false;
  let geminiMode = "success";
  const modelRequests = [];
  modelServer = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const part of req) body += part;
      const input = JSON.parse(body);
      modelRequests.push({ url: req.url, input });
      if (req.url.includes("/models/fixture-gemini:streamGenerateContent")) {
        return geminiResponse(res, geminiMode);
      }
      if (req.url.endsWith(":batchEmbedContents")) {
        return geminiEmbeddingResponse(res, input, rejectEmbeddings ? 400 : "success");
      }
      if (req.url === "/v1/responses") {
        res.setHeader("Content-Type", "text/event-stream");
        for (const delta of ["报销需要发票和审批单。", "\n参考来源：[1]"]) {
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`);
        }
        return res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "fixture-response", status: "completed" } })}\n\n`);
      }
      res.statusCode = 404;
      res.end();
    } catch (error) {
      res.statusCode = 500;
      res.end(error.message);
    }
  });
  const modelUrl = await listen(modelServer);
  Object.assign(process.env, {
    NODE_ENV: "test", PORT: "8787", MYSQL_URL: endpoint.toString(), JWT_SECRET: randomBytes(32).toString("hex"), UPLOAD_DIR: uploadDir,
    ADMIN_EMAIL: "", ADMIN_PASSWORD: "", ADMIN_NAME: "测试管理员", OPENAI_API_KEY: "",
    OPENAI_BASE_URL: `${modelUrl}/v1`, OPENAI_CHAT_MODEL: "fixture-chat", DEEPSEEK_API_KEY: "",
    GEMINI_API_KEY: "fixture-gemini-key", GEMINI_CHAT_MODEL: "fixture-gemini", GEMINI_BASE_URL: modelUrl,
    GEMINI_EMBEDDING_MODEL: "gemini-embedding-2", GEMINI_EMBEDDING_DIMENSIONS: "768",
  });
  const database = await import("../../server/db.ts");
  db = database.db;
  await database.ensureDatabase();
  const { config } = await import("../../server/config.ts");
  const { retrieve } = await import("../../server/ai.ts");
  const { app } = await import("../../server/app.ts");
  apiServer = createServer(app);
  const base = await listen(apiServer);

  async function api(route, { cookie, body, method = "GET" } = {}) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    const multipart = body instanceof FormData;
    if (body !== undefined && !multipart) headers["Content-Type"] = "application/json";
    const response = await fetch(`${base}${route}`, {
      method, headers, body: body === undefined ? undefined : multipart ? body : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : null };
  }
  function cookieOf(response) {
    assert.match(response.headers.get("set-cookie"), /HttpOnly/i);
    return response.headers.get("set-cookie").split(";")[0];
  }
  async function login(email) {
    const response = await api("/api/auth/login", { method: "POST", body: { email, password: "integration-password-123" } });
    assert.equal(response.status, 200, response.text);
    return cookieOf(response);
  }
  async function upload(cookie, filename, content) {
    const body = new FormData();
    body.append("file", new Blob([content], { type: "text/plain" }), filename);
    return api("/api/admin/documents", { method: "POST", cookie, body });
  }

  let admin;
  let adminId;
  let employee;
  let employeeId;
  let otherEmployee;
  let secondAdmin;
  let secondAdminId;
  let documentId;
  let conversationId;
  let messageId;
  const policy = "差旅报销规定：员工需要提交发票和审批单，经主管审核后交给财务处理。请保留所有原始票据。";

  await t.test("legacy message schema upgrades without recreating the tables", async () => {
    await db.query("ALTER TABLE messages DROP COLUMN sequence_no");
    await database.ensureDatabase();
    await database.ensureDatabase();
    const [columns] = await db.query("SHOW COLUMNS FROM messages LIKE 'sequence_no'");
    assert.equal(columns.length, 1);
    assert.match(columns[0].Extra, /auto_increment/);
  });

  await t.test("the normal backend entry point starts and shuts down cleanly", async (subtest) => {
    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    subtest.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        timer.unref();
        await exited;
        clearTimeout(timer);
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Backend startup timed out")), 10000);
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Backend exited ${code}: ${stderr}`)); });
      child.stdout.on("data", (data) => {
        if (data.toString().includes("知问 API 已启动")) { clearTimeout(timer); resolve(); }
      });
    });
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) })).status, 200);
    child.kill("SIGTERM");
    assert.equal((await exited)[0], 0);
  });

  await t.test("one-click launcher creates its database, starts both services, reuses them and cleans up only its children", async (subtest) => {
    const workspace = path.join(uploadDir, "launcher fixture");
    const launcherDatabase = `zhiwen_test_launcher_${randomUUID().replaceAll("-", "")}`;
    const launcherEndpoint = new URL(endpoint);
    launcherEndpoint.pathname = `/${launcherDatabase}`;
    let child;
    let exited;
    async function stopLauncher() {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
        timer.unref();
        try { await exited; } finally { clearTimeout(timer); }
      }
    }
    subtest.after(async () => {
      await stopLauncher();
      await bootstrap.query(`DROP DATABASE IF EXISTS \`${launcherDatabase}\``);
      await fs.rm(workspace, { recursive: true, force: true });
    });
    await fs.mkdir(workspace);
    for (const file of ["start.sh", "server", "app", "index.html", "vite.config.ts", "tsconfig.json", "package.json"]) {
      await fs.cp(path.resolve(file), path.join(workspace, file), { recursive: true });
    }
    await fs.symlink(path.resolve("node_modules"), path.join(workspace, "node_modules"), "dir");
    await fs.writeFile(path.join(workspace, ".env"), "# Isolated launcher test; configuration is inherited from the test process.\n");
    const reservations = [net.createServer(), net.createServer()];
    for (const server of reservations) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
    const [apiPort, webPort] = reservations.map((server) => server.address().port);
    for (const server of reservations) await new Promise((resolve) => server.close(resolve));
    const options = {
      cwd: os.tmpdir(),
      env: { ...process.env, PORT: String(apiPort), WEB_PORT: String(webPort), MYSQL_URL: launcherEndpoint.toString(), UPLOAD_DIR: path.join(workspace, "uploads"), CI: "true" },
    };
    const script = path.join(workspace, "start.sh");
    child = spawn("bash", [script], { ...options, stdio: ["ignore", "pipe", "pipe"] });
    exited = once(child, "exit");
    let output = "";
    let errors = "";
    child.stderr.on("data", (data) => { errors += data; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Launcher startup timed out: ${output}\n${errors}`)), 25000);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Launcher exited ${code}: ${output}\n${errors}`)); });
      child.stdout.on("data", (data) => {
        output += data;
        if (output.includes("启动完成！")) { clearTimeout(timer); resolve(); }
      });
    });
    assert.match(output, /已创建 MYSQL_URL 指定的数据库/);
    assert.match(output, /MySQL 数据表已初始化/);
    assert.equal((await fetch(`http://localhost:${apiPort}/api/health`)).status, 200);
    assert.match(await (await fetch(`http://localhost:${webPort}`)).text(), /\/@vite\/client/);
    const run = promisify(execFile);
    const listeners = await run("lsof", ["-nP", `-iTCP:${webPort}`, "-sTCP:LISTEN", "-Fn"], { timeout: 5000 });
    assert.match(listeners.stdout, new RegExp(`^n\\*:${webPort}$`, "m"), "Frontend must listen on all interfaces, not only localhost");
    const checked = await run("bash", [script, "--check"], { ...options, timeout: 15000 });
    assert.match(checked.stdout, /MySQL 可连接：true/);
    assert.match(checked.stdout, new RegExp(`后端 ${apiPort}：reuse`));
    const reused = await run("bash", [script], { ...options, timeout: 15000 });
    assert.match(reused.stdout, /前后端原本就已运行，没有重复启动/);
    assert.equal(child.exitCode, null);
    await assert.rejects(run("bash", [script], {
      ...options, env: { ...options.env, WEB_PORT: String(apiServer.address().port) }, timeout: 15000,
    }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /已被其他程序占用/);
      return true;
    });
    assert.equal((await api("/api/health")).status, 200);
    await stopLauncher();
    assert.equal((await exited)[0], 143);
    for (const port of [apiPort, webPort]) {
      await assert.rejects(fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(2000) }));
    }
    assert.equal((await api("/api/health")).status, 200);
    const [stillConnected] = await db.query("SELECT 1 AS alive");
    assert.equal(stillConnected[0].alive, 1);
  });

  await t.test("setup, login and role boundaries", async () => {
    assert.equal((await api("/api/health")).status, 200);
    assert.equal((await api("/api/setup")).body.needsSetup, true);
    assert.equal((await api("/api/admin/documents")).status, 401);
    const setup = await api("/api/setup", { method: "POST", body: { email: "admin@example.invalid", displayName: "测试管理员", password: "integration-password-123" } });
    assert.equal(setup.status, 201, setup.text);
    admin = cookieOf(setup);
    adminId = setup.body.user.id;
    assert.equal((await api("/api/setup")).body.needsSetup, false);
    assert.equal((await api("/api/setup", { method: "POST", body: {} })).status, 409);
    assert.equal((await api(`/api/admin/users/${adminId}`, { method: "PATCH", cookie: admin, body: { role: "employee" } })).status, 400);
    for (const [email, role] of [["employee@example.invalid", "employee"], ["other@example.invalid", "employee"], ["second-admin@example.invalid", "admin"]]) {
      const response = await api("/api/admin/users", { method: "POST", cookie: admin, body: { email, displayName: email, password: "integration-password-123", role } });
      assert.equal(response.status, 201, response.text);
      if (email.startsWith("employee")) employeeId = response.body.id;
      if (role === "admin") secondAdminId = response.body.id;
    }
    employee = await login("employee@example.invalid");
    otherEmployee = await login("other@example.invalid");
    secondAdmin = await login("second-admin@example.invalid");
    assert.equal((await api("/api/admin/users", { cookie: employee })).status, 403);
    assert.equal((await upload(employee, "forbidden.txt", policy)).status, 403);
    assert.equal((await api("/api/auth/login", { method: "POST", body: { email: "employee@example.invalid", password: "wrong" } })).status, 401);
  });

  await t.test("upload and MySQL vector storage work with only a Gemini key", async () => {
    assert.equal(config.OPENAI_API_KEY, undefined);
    const response = await upload(admin, "policy.txt", policy);
    assert.equal(response.status, 201, response.text);
    documentId = response.body.document.id;
    const list = await api("/api/admin/documents", { cookie: admin });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.body.documents[0].status, "ready");
    assert.ok(list.body.documents[0].chunk_count > 0);
    const [chunks] = await db.execute("SELECT embedding, embedding_space FROM document_chunks WHERE document_id = ?", [documentId]);
    assert.ok(Array.isArray(chunks[0].embedding));
    assert.equal(chunks[0].embedding.length, 768);
    assert.equal(chunks[0].embedding_space, "gemini:gemini-embedding-2:768:qa-v1");
    assert.ok(modelRequests.every((request) => request.url.endsWith(":batchEmbedContents")));
    assert.equal(modelRequests.at(-1).input.requests[0].content.parts[0].text, `title: none | text: ${policy}`);
    assert.equal((await api(`/api/documents/${documentId}/download`, { cookie: employee })).text, policy);
    assert.equal((await api(`/api/documents/${documentId}/download`)).status, 401);
  });

  await t.test("legacy vectors remain intact during migration, block mixed retrieval and can be reindexed", async () => {
    await db.query("ALTER TABLE document_chunks DROP COLUMN embedding_space");
    const [before] = await db.execute("SELECT id, content, embedding FROM document_chunks WHERE document_id = ?", [documentId]);
    await database.ensureDatabase();
    await database.ensureDatabase();
    const [after] = await db.execute("SELECT id, content, embedding, embedding_space FROM document_chunks WHERE document_id = ?", [documentId]);
    assert.deepEqual(after.map(({ embedding_space, ...row }) => { assert.equal(embedding_space, null); return row; }), before);
    const calls = modelRequests.length;
    await assert.rejects(retrieve("报销要求是什么？"), /重建索引/);
    assert.equal(modelRequests.length, calls);
    const reindexed = await api(`/api/admin/documents/${documentId}/reindex`, { method: "POST", cookie: admin });
    assert.equal(reindexed.status, 200, reindexed.text);
    assert.equal((await retrieve("报销要求是什么？"))[0].documentId, documentId);
    assert.equal(config.OPENAI_API_KEY, undefined);
  });

  await t.test("mismatched model, dimensions and corrupt stored vectors never participate in retrieval", async () => {
    const [rows] = await db.execute("SELECT id, embedding, embedding_space FROM document_chunks WHERE document_id = ?", [documentId]);
    const saved = rows[0];
    for (const [space, vector] of [
      ["openai:text-embedding-3-small:768", saved.embedding],
      ["gemini:gemini-embedding-001:768:qa-v1", saved.embedding],
      ["gemini:gemini-embedding-2:1536:qa-v1", saved.embedding],
      [saved.embedding_space, [1, 2, 3]], [saved.embedding_space, Array(768).fill(0)],
    ]) {
      try {
        await db.execute("UPDATE document_chunks SET embedding_space = ?, embedding = ? WHERE id = ?", [space, JSON.stringify(vector), saved.id]);
        const calls = modelRequests.length;
        await assert.rejects(retrieve("报销要求是什么？"), /重建索引/);
        assert.equal(modelRequests.length, calls);
      } finally {
        await db.execute("UPDATE document_chunks SET embedding_space = ?, embedding = ? WHERE id = ?", [saved.embedding_space, JSON.stringify(saved.embedding), saved.id]);
      }
    }
    assert.equal((await retrieve("报销要求是什么？"))[0].documentId, documentId);
  });

  await t.test("only the selected answer provider requires its own additional credentials", async (subtest) => {
    subtest.mock.method(console, "error", () => undefined);
    const { assertChatConfigured } = await import("../../server/ai.ts");
    const calls = modelRequests.length;
    const [before] = await db.query("SELECT COUNT(*) AS count FROM conversations");
    for (const [provider, key] of [["openai", /OPENAI_API_KEY/], ["deepseek", /DEEPSEEK_API_KEY/]]) {
      const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "检查对应模型密钥。", provider } });
      assert.equal(response.status, 500, response.text);
      assert.match(response.body.error, key);
    }
    config.DEEPSEEK_API_KEY = "fixture-deepseek-key";
    try { assert.doesNotThrow(() => assertChatConfigured("deepseek")); }
    finally { config.DEEPSEEK_API_KEY = undefined; }
    assert.equal(modelRequests.length, calls);
    const [after] = await db.query("SELECT COUNT(*) AS count FROM conversations");
    assert.equal(after[0].count, before[0].count);
  });

  await t.test("streamed answer, history, citations, private conversations and feedback", async () => {
    config.OPENAI_API_KEY = "fixture-not-a-real-api-key";
    const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "差旅报销需要哪些材料？", provider: "openai" } });
    assert.equal(response.status, 200, response.text);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const events = response.text.trim().split("\n\n").map((block) => ({ type: block.match(/^event: (.+)/m)?.[1], data: JSON.parse(block.match(/^data: (.+)/m)[1]) }));
    assert.equal(events[0].type, "sources");
    assert.equal(events.at(-1).type, "done");
    assert.equal(events.filter((event) => event.type === "delta").map((event) => event.data.text).join(""), "报销需要发票和审批单。\n参考来源：[1]");
    ({ conversationId, messageId } = events.at(-1).data);
    assert.equal(events.at(-1).data.citations[0].documentId, documentId);
    const history = await api(`/api/conversations/${conversationId}`, { cookie: employee });
    assert.equal(history.status, 200, history.text);
    assert.equal(history.body.messages.length, 2);
    assert.deepEqual(history.body.messages.map((message) => message.role), ["user", "assistant"]);
    const answer = history.body.messages.find((message) => message.role === "assistant");
    assert.equal(answer.id, messageId);
    assert.equal(answer.citations[0].documentId, documentId);
    assert.match(modelRequests.find((request) => request.url === "/v1/responses").input.instructions, /差旅报销规定/);
    assert.equal((await api(`/api/conversations/${conversationId}`, { cookie: otherEmployee })).status, 404);
    assert.equal((await api("/api/feedback", { method: "POST", cookie: otherEmployee, body: { messageId, rating: "up" } })).status, 404);
    const userMessage = history.body.messages.find((message) => message.role === "user");
    assert.equal((await api("/api/feedback", { method: "POST", cookie: employee, body: { messageId: userMessage.id, rating: "up" } })).status, 404);
    for (const rating of ["up", "down"]) assert.equal((await api("/api/feedback", { method: "POST", cookie: employee, body: { messageId, rating } })).status, 204);
    const [feedback] = await db.execute("SELECT rating FROM feedback WHERE message_id = ? AND user_id = ?", [messageId, employeeId]);
    assert.deepEqual(feedback.map((row) => row.rating), ["down"]);
    const audit = await api("/api/admin/audit", { cookie: admin });
    assert.equal(audit.status, 200, audit.text);
    assert.deepEqual(audit.body.logs.find((log) => log.action === "ask_question" && log.detail?.provider === "openai").detail, { provider: "openai", sources: 1 });
  });

  await t.test("follow-up questions preserve same-second history and model context", async () => {
    // Force a timestamp tie to cover the original second-resolution schema deterministically.
    await db.execute("UPDATE messages SET created_at = CURRENT_TIMESTAMP WHERE conversation_id = ?", [conversationId]);
    const followup = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "这些材料需要谁审核？", conversationId, provider: "openai" } });
    assert.equal(followup.status, 200, followup.text);
    assert.match(followup.text, /event: done/);
    const modelInput = modelRequests.filter((request) => request.url === "/v1/responses").at(-1).input.input;
    assert.deepEqual(modelInput.map((message) => message.role), ["user", "assistant", "user"]);
    assert.equal(modelInput[0].content, "差旅报销需要哪些材料？");
    assert.equal(modelInput.at(-1).content, "这些材料需要谁审核？");
    const history = await api(`/api/conversations/${conversationId}`, { cookie: employee });
    assert.deepEqual(history.body.messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
    config.OPENAI_API_KEY = undefined;
  });

  await t.test("Gemini schema upgrade preserves previous answers and is repeatable", async () => {
    const [before] = await db.execute("SELECT id, provider, content FROM messages WHERE conversation_id = ? ORDER BY sequence_no", [conversationId]);
    await db.query("ALTER TABLE messages MODIFY COLUMN provider ENUM('openai', 'deepseek') NULL");
    await database.ensureDatabase();
    await database.ensureDatabase();
    const [columns] = await db.query("SHOW COLUMNS FROM messages LIKE 'provider'");
    assert.match(columns[0].Type, /'gemini'/);
    const [after] = await db.execute("SELECT id, provider, content FROM messages WHERE conversation_id = ? ORDER BY sequence_no", [conversationId]);
    assert.deepEqual(after, before);
  });

  await t.test("Gemini-only credentials support the complete upload, retrieval and streamed-answer flow", async () => {
    assert.equal(config.OPENAI_API_KEY, undefined);
    const calls = modelRequests.length;
    const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "报销需要哪些证明？" } });
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /event: done/);
    assert.match(response.text, /Gemini：报销需要发票和审批单/);
    const requests = modelRequests.slice(calls);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].url.endsWith(":batchEmbedContents"));
    assert.equal(requests[0].input.requests[0].content.parts[0].text, "task: question answering | query: 报销需要哪些证明？");
    assert.equal(requests[0].input.requests[0].outputDimensionality, 768);
    assert.ok(requests[1].url.includes(":streamGenerateContent"));
    assert.match(requests[1].input.systemInstruction.parts[0].text, /差旅报销规定/);
  });

  await t.test("Gemini is the API default and persists streamed answers, context and citations", async () => {
    const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "请再次确认报销资料。", conversationId } });
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /Gemini：报销需要发票和审批单/);
    assert.match(response.text, /event: done/);
    assert.doesNotMatch(response.text, /Fixture thought/);
    const input = modelRequests.filter((request) => request.url.includes(":streamGenerateContent")).at(-1).input;
    assert.deepEqual(input.contents.map((message) => message.role), ["user", "model", "user", "model", "user"]);
    assert.equal(input.contents[1].parts[0].text, "报销需要发票和审批单。\n参考来源：[1]");
    assert.match(input.systemInstruction.parts[0].text, /差旅报销规定/);
    const history = await api(`/api/conversations/${conversationId}`, { cookie: employee });
    assert.equal(history.status, 200, history.text);
    assert.equal(history.body.messages.at(-1).provider, "gemini");
    assert.equal(history.body.messages.at(-1).citations[0].documentId, documentId);
    assert.equal(history.body.messages[1].provider, "openai");
    const audit = await api("/api/admin/audit", { cookie: admin });
    assert.equal(audit.status, 200, audit.text);
    assert.ok(audit.body.logs.some((log) => log.action === "ask_question" && log.detail?.provider === "gemini"));
    const explicit = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "Gemini 继续说明。", conversationId, provider: "gemini" } });
    assert.equal(explicit.status, 200, explicit.text);
    assert.match(explicit.text, /event: done/);
    assert.equal(modelRequests.filter((request) => request.url.includes(":streamGenerateContent")).at(-1).input.contents.at(-2).role, "model");
  });

  await t.test("Gemini stream interruption sends an error and never persists a completed answer", async () => {
    const [before] = await db.query("SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'");
    let response;
    geminiMode = "interrupted";
    try {
      response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "测试中断的回答。" } });
    } finally { geminiMode = "success"; }
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /event: error/);
    assert.match(response.text, /响应中断/);
    assert.doesNotMatch(response.text, /event: done/);
    const [after] = await db.query("SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'");
    assert.equal(after[0].count, before[0].count);
  });

  await t.test("missing default Gemini credentials cause no question writes or embedding calls", async (subtest) => {
    subtest.mock.method(console, "error", () => undefined);
    const { config } = await import("../../server/config.ts");
    const savedKey = config.GEMINI_API_KEY;
    const requestsBefore = modelRequests.length;
    const [before] = await db.query("SELECT COUNT(*) AS count FROM conversations");
    config.GEMINI_API_KEY = undefined;
    try {
      const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "缺少密钥时测试。" } });
      assert.equal(response.status, 500, response.text);
      assert.match(response.body.error, /GEMINI_API_KEY/);
      assert.equal(modelRequests.length, requestsBefore);
      const [after] = await db.query("SELECT COUNT(*) AS count FROM conversations");
      assert.equal(after[0].count, before[0].count);
    } finally { config.GEMINI_API_KEY = savedKey; }
  });

  await t.test("indexing failure retains a retryable document and its original file", async (subtest) => {
    const errors = [];
    subtest.mock.method(console, "error", (...args) => errors.push(args));
    rejectEmbeddings = true;
    const failed = await upload(admin, "retry-policy.txt", policy);
    rejectEmbeddings = false;
    assert.equal(failed.status, 500);
    assert.match(String(errors[0][0]), /Gemini 向量请求参数无效/);
    const list = await api("/api/admin/documents", { cookie: admin });
    const document = list.body.documents.find((item) => item.filename === "retry-policy.txt");
    assert.equal(document.status, "failed");
    assert.match(document.error_message, /Gemini 向量请求参数无效/);
    const [rows] = await db.execute("SELECT storage_path FROM documents WHERE id = ?", [document.id]);
    assert.equal(await fs.readFile(rows[0].storage_path, "utf8"), policy);
    assert.equal((await api(`/api/admin/documents/${document.id}/reindex`, { method: "POST", cookie: admin })).status, 200);
    assert.equal((await api(`/api/documents/${document.id}/download`, { cookie: employee })).text, policy);
    assert.equal((await api(`/api/admin/documents/${document.id}`, { method: "DELETE", cookie: admin })).status, 204);
    await assert.rejects(fs.stat(rows[0].storage_path), { code: "ENOENT" });
    const before = await fs.readdir(uploadDir);
    assert.equal((await upload(admin, "empty.txt", "太短")).status, 400);
    assert.deepEqual(await fs.readdir(uploadDir), before);
  });

  await t.test("failed reindex keeps previous chunks intact and a retry replaces them atomically", async (subtest) => {
    subtest.mock.method(console, "error", () => undefined);
    const [before] = await db.execute("SELECT id, content, embedding, embedding_space FROM document_chunks WHERE document_id = ?", [documentId]);
    rejectEmbeddings = true;
    try {
      const response = await api(`/api/admin/documents/${documentId}/reindex`, { method: "POST", cookie: admin });
      assert.equal(response.status, 500, response.text);
      const [after] = await db.execute("SELECT id, content, embedding, embedding_space FROM document_chunks WHERE document_id = ?", [documentId]);
      assert.deepEqual(after, before);
    } finally { rejectEmbeddings = false; }
    const response = await api(`/api/admin/documents/${documentId}/reindex`, { method: "POST", cookie: admin });
    assert.equal(response.status, 200, response.text);
    const [after] = await db.execute("SELECT id, embedding_space FROM document_chunks WHERE document_id = ?", [documentId]);
    assert.equal(after.length, before.length);
    assert.notEqual(after[0].id, before[0].id);
    assert.equal(after[0].embedding_space, "gemini:gemini-embedding-2:768:qa-v1");
    assert.equal((await retrieve("报销要求是什么？"))[0].documentId, documentId);
  });

  await t.test("disabling and demoting invalidate existing permissions immediately", async () => {
    assert.equal((await api(`/api/admin/users/${employeeId}`, { method: "PATCH", cookie: admin, body: { isActive: false } })).status, 204);
    assert.equal((await api("/api/auth/me", { cookie: employee })).status, 401);
    assert.equal((await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "报销规定" } })).status, 401);
    assert.equal((await api("/api/auth/login", { method: "POST", body: { email: "employee@example.invalid", password: "integration-password-123" } })).status, 401);
    assert.equal((await api(`/api/admin/users/${employeeId}`, { method: "PATCH", cookie: admin, body: { isActive: true } })).status, 204);
    assert.equal((await api("/api/admin/documents", { cookie: secondAdmin })).status, 200);
    assert.equal((await api(`/api/admin/users/${secondAdminId}`, { method: "PATCH", cookie: admin, body: { role: "employee" } })).status, 204);
    assert.equal((await api("/api/admin/documents", { cookie: secondAdmin })).status, 403);
    assert.equal((await api("/api/auth/me", { cookie: secondAdmin })).body.user.role, "employee");
    assert.equal((await api(`/api/admin/users/${adminId}`, { method: "PATCH", cookie: admin, body: { role: "employee" } })).status, 400);
    assert.equal((await api(`/api/admin/users/${adminId}`, { method: "PATCH", cookie: admin, body: { isActive: false } })).status, 400);
    assert.equal((await api("/api/admin/users/999999", { method: "PATCH", cookie: admin, body: { role: "employee" } })).status, 404);
  });

  await t.test("concurrent administrator demotions always retain an active administrator", async () => {
    const created = await api("/api/admin/users", { method: "POST", cookie: admin, body: { email: "concurrent-admin@example.invalid", displayName: "并发测试管理员", password: "integration-password-123", role: "admin" } });
    assert.equal(created.status, 201, created.text);
    const concurrentId = created.body.id;
    const concurrentCookie = await login("concurrent-admin@example.invalid");
    const results = await Promise.all([
      api(`/api/admin/users/${adminId}`, { method: "PATCH", cookie: admin, body: { role: "employee" } }),
      api(`/api/admin/users/${concurrentId}`, { method: "PATCH", cookie: concurrentCookie, body: { role: "employee" } }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [204, 400]);
    const [active] = await db.query("SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE");
    assert.equal(active.length, 1);
    if (Number(active[0].id) === concurrentId) admin = concurrentCookie;
  });

  await t.test("deletion removes vectors and download; logout clears the browser cookie", async () => {
    assert.equal((await api(`/api/admin/documents/${documentId}`, { method: "DELETE", cookie: admin })).status, 204);
    const [chunks] = await db.execute("SELECT id FROM document_chunks WHERE document_id = ?", [documentId]);
    assert.equal(chunks.length, 0);
    assert.equal((await api(`/api/documents/${documentId}/download`, { cookie: admin })).status, 404);
    const response = await api("/api/auth/logout", { method: "POST", cookie: admin });
    assert.equal(response.status, 204);
    assert.match(response.headers.get("set-cookie"), /zhiwen_session=;/);
  });
});
