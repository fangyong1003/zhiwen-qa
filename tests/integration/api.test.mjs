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
import { geminiEmbeddingResponse, geminiResponse, googleSearchResponse } from "../helpers/gemini.mjs";
import { deepSeekAnswer, deepSeekResponse } from "../helpers/deepseek.mjs";

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
  let geminiAnswer;
  let searchMode = "success";
  let deepSeekMode = "success";
  const modelRequests = [];
  modelServer = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const part of req) body += part;
      const input = JSON.parse(body);
      modelRequests.push({ url: req.url, input });
      if (req.url === "/chat/completions") return deepSeekResponse(res, deepSeekMode);
      if (req.url.includes("/models/fixture-gemini:generateContent")) {
        return googleSearchResponse(res, searchMode);
      }
      if (req.url.includes("/models/fixture-gemini:streamGenerateContent")) {
        const instructions = input.systemInstruction?.parts?.[0]?.text ?? "";
        if (instructions.startsWith("CONVERSATION_SUMMARY")) return geminiResponse(res, "success", [JSON.stringify({ summary: "用户在讨论差旅报销，预算为 300 元；需要核对审批材料。" }), ""]);
        if (instructions.startsWith("CONVERSATION_QUERY")) return geminiResponse(res, "success", [JSON.stringify({ query: "差旅报销需要谁审批？", clarification: null }), ""]);
        return geminiResponse(res, geminiMode, geminiAnswer);
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
    DEEPSEEK_CHAT_MODEL: "fixture-deepseek", DEEPSEEK_BASE_URL: modelUrl,
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
    for (const file of ["start.sh", "server", "app", "shared", "index.html", "vite.config.ts", "tsconfig.json", "package.json"]) {
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
    assert.deepEqual(events[0].data.citations, [], "Retrieval candidates are not confirmed sources while generation is in flight");
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
    assert.equal(answer.feedback, null);
    assert.equal((await api("/api/feedback", { method: "POST", cookie: employee, body: { messageId, rating: "up", note: "首次评价" } })).status, 204);
    for (const rating of ["up", "down"]) {
      const duplicate = await api("/api/feedback", { method: "POST", cookie: employee, body: { messageId, rating, note: "尝试覆盖" } });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.body.rating, "up");
      assert.match(duplicate.body.error, /只能评价一次/);
    }
    const [feedback] = await db.execute("SELECT rating, note FROM feedback WHERE message_id = ? AND user_id = ?", [messageId, employeeId]);
    assert.deepEqual(feedback.map(({ rating, note }) => ({ rating, note })), [{ rating: "up", note: "首次评价" }]);
    const reloaded = await api(`/api/conversations/${conversationId}`, { cookie: employee });
    assert.equal(reloaded.body.messages.find((message) => message.id === messageId).feedback, "up");
    const [feedbackLogs] = await db.execute("SELECT detail FROM audit_logs WHERE action = 'feedback' AND target_id = ?", [messageId]);
    assert.deepEqual(feedbackLogs.map((row) => row.detail), [{ rating: "up" }]);
    const audit = await api("/api/admin/audit", { cookie: admin });
    assert.equal(audit.status, 200, audit.text);
    assert.deepEqual(audit.body.logs.find((log) => log.action === "ask_question" && log.detail?.provider === "openai").detail, { provider: "openai", sources: 1 });
  });

  await t.test("concurrent feedback keeps exactly one vote and independent answers can each be rated", async (subtest) => {
    subtest.mock.method(console, "error", () => undefined);
    const id = randomUUID();
    const answerIds = [randomUUID(), randomUUID()];
    await db.execute("INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)", [id, employeeId, "并发评价测试"]);
    for (const answerId of answerIds) await db.execute("INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'assistant', ?)", [answerId, id, "可评价回答"]);
    const results = await Promise.all(["up", "down"].map((rating) => api("/api/feedback", { method: "POST", cookie: employee, body: { messageId: answerIds[0], rating } })));
    assert.deepEqual(results.map((result) => result.status).sort(), [204, 409]);
    const winningRating = results[0].status === 204 ? "up" : "down";
    assert.equal(results.find((result) => result.status === 409).body.rating, winningRating);
    const [votes] = await db.execute("SELECT rating FROM feedback WHERE message_id = ?", [answerIds[0]]);
    assert.deepEqual(votes.map((row) => row.rating), [winningRating]);
    const [logs] = await db.execute("SELECT detail FROM audit_logs WHERE action = 'feedback' AND target_id = ?", [answerIds[0]]);
    assert.deepEqual(logs.map((row) => row.detail), [{ rating: winningRating }]);
    assert.equal((await api("/api/feedback", { method: "POST", cookie: employee, body: { messageId: answerIds[1], rating: "down" } })).status, 204);
    const history = await api(`/api/conversations/${id}`, { cookie: employee });
    assert.deepEqual(history.body.messages.map((message) => message.feedback), [winningRating, "down"]);
    assert.equal((await api("/api/feedback", { method: "POST", body: { messageId: answerIds[0], rating: "up" } })).status, 401);
    assert.equal((await api("/api/feedback", { method: "POST", cookie: otherEmployee, body: { messageId: answerIds[0], rating: "up" } })).status, 404);
    assert.equal((await api("/api/feedback", { method: "POST", cookie: employee, body: { messageId: answerIds[0], rating: "invalid" } })).status, 400);
  });

  await t.test("failed feedback transactions leave no vote or audit record and allow a retry", async (subtest) => {
    const id = randomUUID();
    const answerId = randomUUID();
    await db.execute("INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)", [id, employeeId, "评价失败重试测试"]);
    await db.execute("INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'assistant', ?)", [answerId, id, "可评价回答"]);
    const connection = await db.getConnection();
    const execute = connection.execute.bind(connection);
    const getter = subtest.mock.method(db, "getConnection", async () => connection);
    const executor = subtest.mock.method(connection, "execute", async (sql, values) => {
      if (sql.startsWith("INSERT INTO audit_logs")) throw new Error("模拟审计写入失败");
      return execute(sql, values);
    });
    subtest.mock.method(console, "error", () => undefined);
    try {
      const failed = await api("/api/feedback", { method: "POST", cookie: employee, body: { messageId: answerId, rating: "up" } });
      assert.equal(failed.status, 500);
    } finally {
      getter.mock.restore();
      executor.mock.restore();
    }
    const [votes] = await db.execute("SELECT id FROM feedback WHERE message_id = ?", [answerId]);
    const [logs] = await db.execute("SELECT id FROM audit_logs WHERE action = 'feedback' AND target_id = ?", [answerId]);
    assert.equal(votes.length, 0);
    assert.equal(logs.length, 0);
    assert.equal((await api("/api/feedback", { method: "POST", cookie: employee, body: { messageId: answerId, rating: "down" } })).status, 204);
    assert.equal((await api(`/api/conversations/${id}`, { cookie: employee })).body.messages[0].feedback, "down");
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

  await t.test("DeepSeek persists streamed answers, references and follow-up history without changing Gemini default", async () => {
    config.DEEPSEEK_API_KEY = "fixture-deepseek-key";
    try {
      const calls = modelRequests.length;
      const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "DeepSeek 请说明报销材料。", provider: "deepseek" } });
      assert.equal(response.status, 200, response.text);
      assert.match(response.text, /event: done/);
      assert.ok(!response.text.includes("private reasoning"));
      const done = JSON.parse(response.text.trim().split("\n\n").at(-1).match(/^data: (.+)/m)[1]);
      assert.equal(done.citations[0].documentId, documentId);
      const requests = modelRequests.slice(calls);
      assert.equal(requests.length, 2);
      assert.ok(requests[0].url.endsWith(":batchEmbedContents"));
      assert.equal(requests[1].url, "/chat/completions");
      assert.equal(requests[1].input.model, "fixture-deepseek");
      assert.match(requests[1].input.messages[0].content, /差旅报销规定/);
      const history = await api(`/api/conversations/${done.conversationId}`, { cookie: employee });
      assert.equal(history.body.messages.at(-1).content, deepSeekAnswer);
      assert.equal(history.body.messages.at(-1).provider, "deepseek");
      assert.deepEqual(history.body.messages.at(-1).citations, done.citations);
      const followup = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "需要谁审核？", conversationId: done.conversationId, provider: "deepseek" } });
      assert.match(followup.text, /event: done/);
      const messages = modelRequests.filter((request) => request.url === "/chat/completions").at(-1).input.messages;
      assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
      assert.equal(messages[2].content, deepSeekAnswer);
      const audit = await api("/api/admin/audit", { cookie: admin });
      assert.ok(audit.body.logs.some((log) => log.action === "ask_question" && log.detail?.provider === "deepseek" && log.detail.sources === 1));
      const next = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "继续说明报销材料。", conversationId: done.conversationId } });
      assert.match(next.text, /event: done/);
      assert.match(next.text, /Gemini：/);
    } finally { config.DEEPSEEK_API_KEY = undefined; }
  });

  for (const mode of ["interrupted", "empty", 402]) {
    await t.test(`DeepSeek ${mode} is an SSE error and never persists a successful assistant message`, async () => {
      config.DEEPSEEK_API_KEY = "fixture-deepseek-key";
      deepSeekMode = mode;
      const [before] = await db.query("SELECT COUNT(*) AS total FROM messages WHERE role = 'assistant'");
      const [auditBefore] = await db.query("SELECT COUNT(*) AS total FROM audit_logs WHERE action = 'ask_question'");
      try {
        const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "DeepSeek 失败回归测试。", provider: "deepseek" } });
        assert.equal(response.status, 200, response.text);
        assert.match(response.text, /event: error/);
        assert.ok(!response.text.includes("event: done"));
        assert.ok(!response.text.includes("Fixture private"));
        if (mode === 402) assert.match(response.text, /账户余额不足/);
        const [after] = await db.query("SELECT COUNT(*) AS total FROM messages WHERE role = 'assistant'");
        const [auditAfter] = await db.query("SELECT COUNT(*) AS total FROM audit_logs WHERE action = 'ask_question'");
        assert.equal(after[0].total, before[0].total);
        assert.equal(auditAfter[0].total, auditBefore[0].total);
      } finally { config.DEEPSEEK_API_KEY = undefined; deepSeekMode = "success"; }
    });
  }

  await t.test("missing DeepSeek key fails before creating a conversation or calling embeddings", async () => {
    assert.equal(config.DEEPSEEK_API_KEY, undefined);
    const calls = modelRequests.length;
    const [before] = await db.query("SELECT COUNT(*) AS total FROM conversations");
    const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "DeepSeek 缺少密钥测试。", provider: "deepseek" } });
    assert.equal(response.status, 500);
    assert.match(response.body.error, /DEEPSEEK_API_KEY/);
    const [after] = await db.query("SELECT COUNT(*) AS total FROM conversations");
    assert.equal(after[0].total, before[0].total);
    assert.equal(modelRequests.length, calls);
  });

  await t.test("DeepSeek answers keep Google search separate from knowledge context", async () => {
    config.DEEPSEEK_API_KEY = "fixture-deepseek-key";
    const calls = modelRequests.length;
    try {
      const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "查阅公开资料并说明报销要求。", provider: "deepseek", webSearch: true } });
      assert.match(response.text, /event: done/);
      assert.match(response.text, /公开网页说明/);
      const requests = modelRequests.slice(calls);
      assert.equal(requests.length, 3);
      const search = requests.find((request) => request.url.endsWith(":generateContent"));
      assert.ok(search);
      assert.ok(!JSON.stringify(search.input).includes(policy));
      const answer = requests.find((request) => request.url === "/chat/completions");
      assert.ok(answer);
      assert.ok(!JSON.stringify(answer.input).includes("公开网页说明"));
      assert.match(answer.input.messages[0].content, /差旅报销规定/);
      assert.equal(answer.input.tools, undefined);
    } finally { config.DEEPSEEK_API_KEY = undefined; }
  });

  await t.test("uncited candidates never appear in streamed sources, stored answers, history or audit counts", async () => {
    geminiAnswer = ["知识库中没有足够资料确认此问题，建议咨询对应负责人。", ""];
    let response;
    try {
      response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "今天外面的天气如何？" } });
    } finally { geminiAnswer = undefined; }
    assert.equal(response.status, 200, response.text);
    const events = response.text.trim().split("\n\n").map((block) => ({ type: block.match(/^event: (.+)/m)?.[1], data: JSON.parse(block.match(/^data: (.+)/m)[1]) }));
    assert.deepEqual(events[0].data.citations, []);
    assert.equal(events.at(-1).type, "done");
    const result = events.at(-1).data;
    assert.deepEqual(result.citations, []);
    assert.ok(!response.text.includes(documentId), "Unused document metadata must not leak through the sources event");
    const [saved] = await db.execute("SELECT citations FROM messages WHERE id = ?", [result.messageId]);
    assert.deepEqual(saved[0].citations, []);
    const history = await api(`/api/conversations/${result.conversationId}`, { cookie: employee });
    assert.deepEqual(history.body.messages.at(-1).citations, []);
    const instructions = modelRequests.filter((request) => request.url.includes(":streamGenerateContent")).at(-1).input.systemInstruction.parts[0].text;
    assert.match(instructions, /忽略不相关或未使用的片段/);
    assert.match(instructions, /不要输出引用编号/);
    const audit = await api("/api/admin/audit", { cookie: admin });
    assert.ok(audit.body.logs.some((log) => log.action === "ask_question" && log.detail?.provider === "gemini" && log.detail?.sources === 0));
  });

  await t.test("only the cited chunk is saved and its original number survives history round-trips", async () => {
    const extra = await upload(admin, "approval.txt", "审批单填写说明：差旅报销提交前应由主管确认金额并签字。请核对发票日期与申请金额。");
    assert.equal(extra.status, 201, extra.text);
    const extraId = extra.body.document.id;
    try {
      const question = "差旅报销审批材料如何核对？";
      const context = await retrieve(question);
      assert.equal(context.length, 2);
      geminiAnswer = ["核对申请金额与发票日期。[2]", "\n参考来源：[2] [2] [99]"];
      const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question } });
      assert.equal(response.status, 200, response.text);
      const events = response.text.trim().split("\n\n").map((block) => ({ type: block.match(/^event: (.+)/m)?.[1], data: JSON.parse(block.match(/^data: (.+)/m)[1]) }));
      assert.deepEqual(events[0].data.citations, []);
      assert.equal(events.at(-1).type, "done");
      const result = events.at(-1).data;
      assert.equal(result.citations.length, 1);
      assert.equal(result.citations[0].documentId, context[1].documentId);
      assert.equal(result.citations[0].referenceNumber, 2);
      const [saved] = await db.execute("SELECT content, citations FROM messages WHERE id = ?", [result.messageId]);
      assert.match(saved[0].content, /\[2\]/);
      assert.deepEqual(saved[0].citations, result.citations);
      const history = await api(`/api/conversations/${result.conversationId}`, { cookie: employee });
      assert.deepEqual(history.body.messages.at(-1).citations, result.citations);
    } finally {
      geminiAnswer = undefined;
      assert.equal((await api(`/api/admin/documents/${extraId}`, { method: "DELETE", cookie: admin })).status, 204);
    }
  });

  await t.test("legacy history is filtered on read without changing its stored content or candidate metadata", async () => {
    const id = randomUUID();
    await db.execute("INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)", [id, employeeId, "旧引用兼容性测试"]);
    const candidates = [1, 2].map((number) => ({ documentId, title: `旧片段 ${number}`, filename: "policy.txt", chunkIndex: number - 1, excerpt: `旧摘要 ${number}`, score: 0.8 }));
    for (const content of ["知识库中没有足够资料确认此问题。", "实际使用第二个片段。\n参考来源：[2]"]) {
      await db.execute("INSERT INTO messages (id, conversation_id, role, content, citations) VALUES (?, ?, 'assistant', ?, ?)", [randomUUID(), id, content, JSON.stringify(candidates)]);
    }
    const [before] = await db.execute("SELECT id, content, citations FROM messages WHERE conversation_id = ? ORDER BY sequence_no", [id]);
    const history = await api(`/api/conversations/${id}`, { cookie: employee });
    assert.equal(history.status, 200, history.text);
    assert.deepEqual(history.body.messages[0].citations, []);
    assert.deepEqual(history.body.messages[1].citations, [{ ...candidates[1], referenceNumber: 2 }]);
    const [after] = await db.execute("SELECT id, content, citations FROM messages WHERE conversation_id = ? ORDER BY sequence_no", [id]);
    assert.deepEqual(after, before);
  });

  await t.test("web supplements remain available when the knowledge answer has no citations", async () => {
    geminiAnswer = ["知识库中没有足够资料确认此问题。", ""];
    try {
      const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "请查询最新的公开资料。", webSearch: true } });
      assert.equal(response.status, 200, response.text);
      const block = response.text.trim().split("\n\n").at(-1);
      assert.match(block, /^event: done/);
      const done = JSON.parse(block.match(/^data: (.+)/m)[1]);
      assert.deepEqual(done.citations, []);
      assert.equal(done.webResult.searched, true);
      assert.equal(done.webResult.sources.length, 2);
      assert.match(done.webResult.text, /公开网页说明/);
    } finally { geminiAnswer = undefined; }
  });

  await t.test("search-mode schema upgrade preserves old messages and defaults to off", async () => {
    const [before] = await db.query("SELECT id, content, citations FROM messages ORDER BY sequence_no");
    await db.query("ALTER TABLE messages DROP COLUMN web_search");
    await database.ensureDatabase();
    await database.ensureDatabase();
    const [after] = await db.query("SELECT id, content, citations FROM messages ORDER BY sequence_no");
    assert.deepEqual(after, before);
    const history = await api(`/api/conversations/${conversationId}`, { cookie: employee });
    assert.ok(history.body.messages.every((message) => message.webSearch === false));
  });

  let searchedConversationId;
  await t.test("opt-in search returns separate grounded sources without exposing knowledge or history to Search", async () => {
    const calls = modelRequests.length;
    const question = "今天的公开资料指南有什么更新？";
    const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question, webSearch: true } });
    assert.equal(response.status, 200, response.text);
    const events = response.text.trim().split("\n\n").map((block) => ({ type: block.match(/^event: (.+)/m)?.[1], data: JSON.parse(block.match(/^data: (.+)/m)[1]) }));
    assert.equal(events.at(-1).type, "done");
    const result = events.at(-1).data;
    searchedConversationId = result.conversationId;
    assert.equal(result.webSearch, true);
    assert.equal(result.webResult.searched, true);
    assert.equal(result.webResult.sources.length, 2);
    assert.equal(result.webResult.text, "公开网页说明：请查阅官方公布的最新资料。");
    assert.match(result.webResult.searchSuggestions, /Google 搜索建议/);
    assert.equal(result.citations[0].documentId, documentId);
    const requests = modelRequests.slice(calls);
    const searchRequest = requests.find((request) => request.url.endsWith(":generateContent")).input;
    assert.deepEqual(searchRequest.tools, [{ googleSearch: {} }]);
    assert.deepEqual(searchRequest.contents, [{ role: "user", parts: [{ text: question }] }]);
    assert.ok(!JSON.stringify(searchRequest).includes(policy));
    assert.ok(!JSON.stringify(searchRequest).includes("请再次确认报销资料"));
    const answerRequest = requests.find((request) => request.url.includes(":streamGenerateContent")).input;
    assert.match(answerRequest.systemInstruction.parts[0].text, /差旅报销规定/);
    assert.ok(!JSON.stringify(answerRequest).includes(result.webResult.text));
    assert.equal(answerRequest.tools, undefined);
    const history = await api(`/api/conversations/${searchedConversationId}`, { cookie: employee });
    assert.ok(history.body.messages.every((message) => message.webSearch === true));
    assert.ok(history.body.messages.every((message) => message.webResult === undefined));
    assert.ok(!JSON.stringify(history.body.messages).includes(result.webResult.text));
    const audit = await api("/api/admin/audit", { cookie: admin });
    assert.ok(audit.body.logs.some((log) => log.action === "ask_question" && log.detail?.webSearch === true && log.detail?.webSources === 2));
    assert.equal((await api(`/api/conversations/${searchedConversationId}`, { cookie: otherEmployee })).status, 404);
  });

  await t.test("turning search off in the same conversation makes no search request or reuse of web output", async () => {
    const calls = modelRequests.length;
    const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "这次只查公司知识库。", conversationId: searchedConversationId, webSearch: false } });
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /event: done/);
    const requests = modelRequests.slice(calls);
    assert.equal(requests.length, 2);
    assert.ok(!requests.some((request) => request.url.endsWith(":generateContent")));
    assert.ok(!JSON.stringify(requests).includes("公开网页说明"));
    const done = JSON.parse(response.text.trim().split("\n\n").at(-1).match(/^data: (.+)/m)[1]);
    assert.equal(done.webSearch, false);
    assert.equal(done.webResult, undefined);
  });

  await t.test("Google search is independent of the chosen knowledge-answer model", async () => {
    const previousKey = config.OPENAI_API_KEY;
    config.OPENAI_API_KEY = "fixture-key";
    const calls = modelRequests.length;
    try {
      const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "查阅公开指南并说明公司要求。", provider: "openai", webSearch: true } });
      assert.equal(response.status, 200, response.text);
      assert.match(response.text, /event: done/);
      assert.match(response.text, /公开网页说明/);
      const requests = modelRequests.slice(calls);
      assert.ok(requests.some((request) => request.url.endsWith(":generateContent")));
      const openai = requests.find((request) => request.url === "/v1/responses");
      assert.ok(openai);
      assert.ok(!JSON.stringify(openai.input).includes("公开网页说明"));
    } finally { config.OPENAI_API_KEY = previousKey; }
  });

  await t.test("search without grounded links reports no web result instead of fabricating sources", async () => {
    searchMode = "ungrounded";
    try {
      const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "没有网页来源的问题。", webSearch: true } });
      assert.equal(response.status, 200, response.text);
      const done = JSON.parse(response.text.trim().split("\n\n").at(-1).match(/^data: (.+)/m)[1]);
      assert.deepEqual(done.webResult, { searched: false, text: "", sources: [] });
      assert.doesNotMatch(response.text, /公开网页说明/);
    } finally { searchMode = "success"; }
  });

  await t.test("invalid or unauthenticated search requests cannot invoke the tool", async (subtest) => {
    subtest.mock.method(console, "error", () => undefined);
    const calls = modelRequests.length;
    for (const value of ["true", "false", 1, null]) {
      const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "无效开关参数", webSearch: value } });
      assert.equal(response.status, 400);
    }
    assert.equal((await api("/api/chat/stream", { method: "POST", body: { question: "未登录的联网查询", webSearch: true } })).status, 401);
    assert.equal(modelRequests.length, calls);
  });

  await t.test("search errors do not silently downgrade or save a completed answer", async (subtest) => {
    subtest.mock.method(console, "error", () => undefined);
    const [before] = await db.query("SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'");
    searchMode = 429;
    try {
      const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { question: "联网搜索失败测试。", webSearch: true } });
      assert.equal(response.status, 500);
      assert.match(response.body.error, /联网搜索额度或频率/);
      assert.doesNotMatch(response.text, /Fixture search secret/);
      const [after] = await db.query("SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'");
      assert.equal(after[0].count, before[0].count);
    } finally { searchMode = "success"; }
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

  let privateConversation;
  const privateFiles = [];
  const privateText = "仅会话本人可见的附件标记 PRIVATE-ALPHA。差旅预算为 300 元，需要主管与财务审核，审批规则以附件为准。";
  const enhancedInput = (overrides = {}) => ({ requestId: randomUUID(), conversationId: privateConversation, question: "请说明报销材料。", provider: "gemini", scope: "knowledge", attachmentIds: [], webSearch: false, ...overrides });
  const eventsOf = (response) => response.text.trim().split("\n\n").map((block) => ({ type: block.match(/^event: (.+)/m)?.[1], data: JSON.parse(block.match(/^data: (.+)/m)[1]) }));
  async function waitForAttachment(id, expected = "ready") {
    for (let i = 0; i < 100; i++) {
      const response = await api(`/api/conversations/${privateConversation}/attachments`, { cookie: employee });
      assert.equal(response.status, 200, response.text);
      const file = response.body.attachments.find((item) => item.id === id);
      if (file?.status === expected) return file;
      if (file?.status === "failed" && expected !== "failed") throw new Error(file.error_message);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Attachment processing did not finish");
  }
  async function uploadPrivate(filename, content) {
    const body = new FormData(); body.append("file", new Blob([content]), filename);
    return api(`/api/conversations/${privateConversation}/attachments`, { method: "POST", cookie: employee, body });
  }

  await t.test("private attachment tables and context metadata upgrades preserve existing messages", async () => {
    const [before] = await db.query("SELECT COUNT(*) AS total FROM messages");
    await db.query("ALTER TABLE conversations DROP COLUMN context_summary");
    await db.query("ALTER TABLE conversation_turns DROP COLUMN run_token");
    await database.ensureDatabase();
    await database.ensureDatabase();
    const [after] = await db.query("SELECT COUNT(*) AS total FROM messages");
    assert.equal(after[0].total, before[0].total);
    const response = await api("/api/conversations", { method: "POST", cookie: employee, body: {} });
    assert.equal(response.status, 201, response.text);
    privateConversation = response.body.conversation.id;
  });

  await t.test("ordinary employees upload multiple private files through bounded background parsing", async () => {
    const [before] = await db.query("SELECT COUNT(*) AS total FROM documents");
    for (const [filename, content] of [["报销方案.txt", privateText], ["对比方案.txt", "仅此会话的第二份附件 PRIVATE-BETA。差旅预算为 400 元，审批材料包括原始发票和主管审批单。"]]) {
      const result = await uploadPrivate(filename, content);
      assert.equal(result.status, 202, result.text);
      privateFiles.push(result.body.attachment.id);
      const file = await waitForAttachment(result.body.attachment.id);
      assert.equal(file.filename, filename);
      assert.ok(file.chunk_count > 0);
    }
    const [after] = await db.query("SELECT COUNT(*) AS total FROM documents");
    assert.equal(after[0].total, before[0].total);
    const [privatePaths] = await db.query("SELECT storage_path FROM conversation_attachments WHERE conversation_id = ?", [privateConversation]);
    for (const row of privatePaths) assert.equal((await fs.stat(row.storage_path)).mode & 0o777, 0o600);
  });

  await t.test("private listing, upload, download and model retrieval enforce ownership even for administrators", async () => {
    for (const cookie of [otherEmployee, admin]) {
      assert.equal((await api(`/api/conversations/${privateConversation}/attachments`, { cookie })).status, 404);
      assert.equal((await api(`/api/conversations/${privateConversation}/attachments/${privateFiles[0]}/download`, { cookie })).status, 404);
      const body = new FormData(); body.append("file", new Blob(["forbidden"]), "forbidden.txt");
      assert.equal((await api(`/api/conversations/${privateConversation}/attachments`, { cookie, method: "POST", body })).status, 404);
      assert.equal((await api(`/api/conversations/${privateConversation}/attachments/${privateFiles[0]}`, { cookie, method: "DELETE" })).status, 404);
    }
    const calls = modelRequests.length;
    const denied = await api("/api/chat/stream", { method: "POST", cookie: otherEmployee, body: enhancedInput({ scope: "attachments", attachmentIds: privateFiles }) });
    assert.equal(denied.status, 404);
    assert.equal(modelRequests.length, calls);
    const download = await api(`/api/conversations/${privateConversation}/attachments/${privateFiles[0]}/download`, { cookie: employee });
    assert.equal(download.text, privateText);
    assert.match(download.headers.get("content-disposition"), /attachment/);
    const global = await retrieve("PRIVATE-ALPHA");
    assert.ok(!JSON.stringify(global).includes("PRIVATE-ALPHA"));
  });

  let privateRequest;
  await t.test("attachment-only answers use both files, save private citations and replay without duplicate billing or messages", async () => {
    privateRequest = enhancedInput({ scope: "attachments", attachmentIds: privateFiles });
    const calls = modelRequests.length;
    const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: privateRequest });
    assert.equal(response.status, 200, response.text);
    const events = eventsOf(response);
    assert.equal(events[0].type, "meta");
    assert.equal(events.at(-1).type, "done", response.text);
    assert.equal(events.at(-1).data.citations[0].source, "attachment");
    const input = modelRequests.slice(calls).find((item) => item.url.includes(":streamGenerateContent")).input;
    assert.match(input.systemInstruction.parts[0].text, /PRIVATE-ALPHA/);
    assert.match(input.systemInstruction.parts[0].text, /PRIVATE-BETA/);
    assert.ok(!input.systemInstruction.parts[0].text.includes(policy));
    const total = modelRequests.length;
    const replay = await api("/api/chat/stream", { method: "POST", cookie: employee, body: privateRequest });
    assert.match(replay.text, /"replay":true/);
    assert.match(replay.text, /event: done/);
    assert.equal(modelRequests.length, total);
    const history = await api(`/api/conversations/${privateConversation}`, { cookie: employee });
    assert.equal(history.body.messages.length, 2);
    assert.equal(history.body.messages[1].citations[0].conversationId, privateConversation);
    const changed = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { ...privateRequest, question: "不能复用相同编号修改问题。" } });
    assert.equal(changed.status, 409);
  });

  await t.test("reopened conversations resolve follow-up references before embedding while search never receives history", async () => {
    const calls = modelRequests.length;
    const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: enhancedInput({ question: "这个需要谁审批？", scope: "combined", attachmentIds: privateFiles, webSearch: true }) });
    assert.match(response.text, /event: done/, response.text);
    const requests = modelRequests.slice(calls);
    const planner = requests.find((item) => item.input.systemInstruction?.parts[0]?.text.startsWith("CONVERSATION_QUERY"));
    assert.ok(planner);
    assert.match(JSON.stringify(planner.input), /报销方案/);
    const embeddings = requests.find((item) => item.url.endsWith(":batchEmbedContents"));
    assert.match(JSON.stringify(embeddings.input), /差旅报销需要谁审批/);
    const search = requests.find((item) => item.url.endsWith(":generateContent"));
    assert.equal(search.input.contents[0].parts[0].text, "这个需要谁审批？");
    assert.ok(!JSON.stringify(search.input).includes("PRIVATE-ALPHA"));
  });

  await t.test("failed generation retains partial text and retries the same user message exactly once", async () => {
    const request = enhancedInput();
    geminiMode = "interrupted";
    let response;
    try { response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: request }); }
    finally { geminiMode = "success"; }
    assert.match(response.text, /event: error/);
    let state = await api(`/api/conversations/${privateConversation}/turns`, { cookie: employee });
    const failed = state.body.turns.find((item) => item.id === request.requestId);
    assert.equal(failed.status, "failed");
    assert.match(failed.partial_content, /报销需要/);
    const retry = await api("/api/chat/stream", { method: "POST", cookie: employee, body: request });
    assert.match(retry.text, /event: done/, retry.text);
    state = await api(`/api/conversations/${privateConversation}/turns`, { cookie: employee });
    const success = state.body.turns.find((item) => item.id === request.requestId);
    assert.equal(success.status, "completed");
    assert.equal(success.user_message_id, failed.user_message_id);
    const [count] = await db.execute("SELECT COUNT(*) AS total FROM messages WHERE id IN (?, ?)", [success.user_message_id, success.assistant_message_id]);
    assert.equal(count[0].total, 2);
  });

  await t.test("search failures offer explicit no-search retry without duplicating the question", async () => {
    const request = enhancedInput({ webSearch: true });
    searchMode = 429;
    let response;
    try { response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: request }); }
    finally { searchMode = "success"; }
    assert.match(response.text, /"canContinueWithoutSearch":true/);
    const calls = modelRequests.length;
    const retry = await api("/api/chat/stream", { method: "POST", cookie: employee, body: { ...request, webSearch: false } });
    assert.match(retry.text, /event: done/, retry.text);
    assert.ok(!modelRequests.slice(calls).some((item) => item.url.endsWith(":generateContent")));
    const [rows] = await db.execute("SELECT user_message_id FROM conversation_turns WHERE id = ?", [request.requestId]);
    const [messages] = await db.execute("SELECT web_search FROM messages WHERE id = ?", [rows[0].user_message_id]);
    assert.equal(messages[0].web_search, 0);
  });

  await t.test("cancellation aborts generation, rejects concurrent edits, preserves a partial state and permits retry", async () => {
    const request = enhancedInput();
    geminiMode = "slow";
    const response = await fetch(`${base}/api/chat/stream`, { method: "POST", headers: { Cookie: employee, "Content-Type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(15000) });
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); let text = "";
    try {
      while (!text.includes("event: delta")) { const part = await reader.read(); if (part.done) throw new Error(text); text += decoder.decode(part.value); }
      assert.equal((await api("/api/chat/stream", { method: "POST", cookie: employee, body: request })).status, 409);
      assert.equal((await api("/api/chat/stream", { method: "POST", cookie: employee, body: enhancedInput() })).status, 409);
      assert.equal((await api(`/api/conversations/${privateConversation}/attachments/${privateFiles[0]}`, { method: "DELETE", cookie: employee })).status, 409);
      assert.equal((await api(`/api/chat/turns/${request.requestId}/cancel`, { method: "POST", cookie: otherEmployee })).status, 404);
      assert.equal((await api(`/api/chat/turns/${request.requestId}/cancel`, { method: "POST", cookie: employee })).body.status, "cancelled");
      while (true) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value); }
      assert.match(text, /event: cancelled/);
      assert.ok(!text.includes("event: done"));
    } finally { geminiMode = "success"; await reader.cancel(); }
    const [state] = await db.execute("SELECT status, partial_content, assistant_message_id FROM conversation_turns WHERE id = ?", [request.requestId]);
    assert.equal(state[0].status, "cancelled");
    assert.ok(state[0].partial_content);
    assert.equal(state[0].assistant_message_id, null);
    assert.match((await api("/api/chat/stream", { method: "POST", cookie: employee, body: request })).text, /event: done/);
  });

  await t.test("long conversations persist bounded memory and do not resend full histories", async () => {
    const calls = modelRequests.length;
    for (let i = 0; i < 6; i++) {
      const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: enhancedInput({ question: `报销预算 300 元，材料核对第 ${i} 项。` }) });
      assert.match(response.text, /event: done/, response.text);
    }
    assert.ok(modelRequests.slice(calls).some((item) => item.input.systemInstruction?.parts[0]?.text.startsWith("CONVERSATION_SUMMARY")));
    const [rows] = await db.execute("SELECT context_summary, summary_through FROM conversations WHERE id = ?", [privateConversation]);
    assert.match(rows[0].context_summary, /300 元/);
    assert.ok(Number(rows[0].summary_through) > 0);
    const last = modelRequests.at(-1).input;
    assert.ok(last.contents.length <= 7);
    assert.match(last.systemInstruction.parts[0].text, /历史摘要/);
    assert.ok(Buffer.byteLength(JSON.stringify(last)) < config.CHAT_CONTEXT_TOKENS);
  });

  await t.test("client disconnect cancels the turn and excludes the unfinished exchange from future context", async () => {
    const draft = await api("/api/conversations", { method: "POST", cookie: employee, body: {} });
    const request = enhancedInput({ conversationId: draft.body.conversation.id, question: "UNFINISHED-QUESTION-MARKER 请分析。" });
    geminiMode = "slow";
    geminiAnswer = ["UNFINISHED-ANSWER-MARKER", "不应保存为完整回答。"];
    try {
      const response = await fetch(`${base}/api/chat/stream`, { method: "POST", headers: { Cookie: employee, "Content-Type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(15000) });
      const reader = response.body.getReader(); let text = "";
      while (!text.includes("event: delta")) { const part = await reader.read(); if (part.done) throw new Error(text); text += new TextDecoder().decode(part.value); }
      await reader.cancel();
      let status;
      for (let attempt = 0; attempt < 60; attempt++) {
        const [rows] = await db.execute("SELECT status, assistant_message_id FROM conversation_turns WHERE id = ?", [request.requestId]);
        status = rows[0];
        if (status.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(status.status, "cancelled");
      assert.equal(status.assistant_message_id, null);
    } finally { geminiMode = "success"; geminiAnswer = undefined; }
    const calls = modelRequests.length;
    const next = await api("/api/chat/stream", { method: "POST", cookie: employee, body: enhancedInput({ conversationId: request.conversationId, question: "请说明报销审批流程。" }) });
    assert.match(next.text, /event: done/, next.text);
    assert.ok(!JSON.stringify(modelRequests.slice(calls)).includes("UNFINISHED-"));
    assert.equal((await api("/api/chat/stream", { method: "POST", cookie: employee, body: request })).status, 409);
  });

  await t.test("expired generation leases recover on reopen and retry uses the same user message", async () => {
    const draft = await api("/api/conversations", { method: "POST", cookie: employee, body: {} });
    const request = enhancedInput({ conversationId: draft.body.conversation.id });
    geminiMode = "interrupted";
    try { assert.match((await api("/api/chat/stream", { method: "POST", cookie: employee, body: request })).text, /event: error/); }
    finally { geminiMode = "success"; }
    await db.execute("UPDATE conversation_turns SET status = 'running' WHERE id = ?", [request.requestId]);
    await db.execute("UPDATE conversations SET active_request_id = ?, active_until = NOW() - INTERVAL 1 MINUTE WHERE id = ?", [randomUUID(), request.conversationId]);
    const state = await api(`/api/conversations/${request.conversationId}/turns`, { cookie: employee });
    assert.equal(state.body.turns[0].status, "failed");
    assert.equal(state.body.turns[0].error_code, "interrupted");
    assert.match((await api("/api/chat/stream", { method: "POST", cookie: employee, body: request })).text, /event: done/);
    const [rows] = await db.execute("SELECT role FROM messages WHERE conversation_id = ?", [request.conversationId]);
    assert.equal(rows.length, 2);
  });

  await t.test("attachment IDs cannot be imported into another conversation and cross-site mutations are rejected", async () => {
    const draft = await api("/api/conversations", { method: "POST", cookie: otherEmployee, body: {} });
    const calls = modelRequests.length;
    const response = await api("/api/chat/stream", { method: "POST", cookie: otherEmployee, body: enhancedInput({ conversationId: draft.body.conversation.id, scope: "attachments", attachmentIds: privateFiles }) });
    assert.equal(response.status, 404);
    assert.equal(modelRequests.length, calls);
    const crossSite = await fetch(`${base}/api/conversations`, { method: "POST", headers: { Cookie: employee, Origin: "https://untrusted.example.invalid", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(crossSite.status, 403);
    const sameSite = await fetch(`${base}/api/conversations`, { method: "POST", headers: { Cookie: employee, Origin: base, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(sameSite.status, 201);
  });

  await t.test("ambiguous empty-context questions ask for clarification without searching or generating claims", async () => {
    const draft = await api("/api/conversations", { method: "POST", cookie: employee, body: {} });
    const calls = modelRequests.length;
    const response = await api("/api/chat/stream", { method: "POST", cookie: employee, body: enhancedInput({ conversationId: draft.body.conversation.id, question: "这个怎么处理？" }) });
    assert.match(response.text, /你指的是哪项事项/);
    assert.match(response.text, /event: done/);
    assert.equal(modelRequests.length, calls);
  });

  await t.test("invalid files fail safely and failed indexing can be retried without adding a new attachment", async () => {
    const fake = await uploadPrivate("伪装.pdf", "not a PDF file");
    assert.equal(fake.status, 202);
    const failed = await waitForAttachment(fake.body.attachment.id, "failed");
    assert.match(failed.error_message, /有效的 PDF/);
    await api(`/api/conversations/${privateConversation}/attachments/${failed.id}`, { method: "DELETE", cookie: employee });
    rejectEmbeddings = true;
    let result;
    try { result = await uploadPrivate("重试.txt", "这是可重试的有效附件，报销需要保留原始凭证。"); await waitForAttachment(result.body.attachment.id, "failed"); }
    finally { rejectEmbeddings = false; }
    assert.equal((await api(`/api/conversations/${privateConversation}/attachments/${result.body.attachment.id}/retry`, { method: "POST", cookie: employee })).status, 202);
    await waitForAttachment(result.body.attachment.id);
    await api(`/api/conversations/${privateConversation}/attachments/${result.body.attachment.id}`, { method: "DELETE", cookie: employee });
  });

  await t.test("deleting a private attachment cleans up bytes and vectors, invalidates memory and blocks reuse", async () => {
    const [before] = await db.execute("SELECT storage_path FROM conversation_attachments WHERE id = ?", [privateFiles[0]]);
    const response = await api(`/api/conversations/${privateConversation}/attachments/${privateFiles[0]}`, { method: "DELETE", cookie: employee });
    assert.equal(response.status, 204, response.text);
    await assert.rejects(fs.access(before[0].storage_path));
    const [chunks] = await db.execute("SELECT id FROM attachment_chunks WHERE attachment_id = ?", [privateFiles[0]]);
    assert.equal(chunks.length, 0);
    const [memory] = await db.execute("SELECT context_summary, context_reset_sequence FROM conversations WHERE id = ?", [privateConversation]);
    assert.equal(memory[0].context_summary, null);
    assert.ok(Number(memory[0].context_reset_sequence) > 0);
    assert.equal((await api(`/api/conversations/${privateConversation}/attachments/${privateFiles[0]}/download`, { cookie: employee })).status, 404);
    const calls = modelRequests.length;
    assert.equal((await api("/api/chat/stream", { method: "POST", cookie: employee, body: enhancedInput({ scope: "attachments", attachmentIds: privateFiles }) })).status, 404);
    assert.equal(modelRequests.length, calls);
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
