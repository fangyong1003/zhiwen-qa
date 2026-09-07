import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import mysql from "mysql2/promise";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhiwen-test-mysql-"));
const dataDir = path.join(directory, "data");
const socket = path.join(directory, "mysql.sock");
const binary = process.env.TEST_MYSQLD || "mysqld";
let databaseProcess;
let testProcess;
let databaseExit;

async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) throw new Error(`${command} failed (${signal || code})`);
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForDatabase(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (databaseProcess.exitCode !== null || databaseProcess.signalCode !== null) throw new Error("Temporary MySQL exited before becoming ready");
    let connection;
    try {
      connection = await mysql.createConnection({ host: "127.0.0.1", port, user: "root", connectTimeout: 1000 });
      await connection.query("SELECT 1");
      return;
    } catch {
      await delay(200);
    } finally {
      await connection?.end();
    }
  }
  throw new Error("Temporary MySQL did not become ready in time");
}

function interrupt() {
  testProcess?.kill("SIGTERM");
  databaseProcess?.kill("SIGTERM");
}

process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  console.log("Initializing an isolated temporary MySQL instance…");
  await run(binary, ["--no-defaults", "--initialize-insecure", `--datadir=${dataDir}`, `--log-error=${path.join(directory, "init.log")}`], { timeout: 60000 });
  const port = await freePort();
  databaseProcess = spawn(binary, [
    "--no-defaults", `--datadir=${dataDir}`, `--port=${port}`, "--bind-address=127.0.0.1", `--socket=${socket}`,
    `--pid-file=${path.join(directory, "mysql.pid")}`, `--log-error=${path.join(directory, "mysql.log")}`, "--mysqlx=0", "--skip-log-bin", "--innodb-buffer-pool-size=64M",
  ], { stdio: "inherit" });
  databaseExit = once(databaseProcess, "exit");
  await waitForDatabase(port);
  console.log(`Temporary MySQL ready on 127.0.0.1:${port}; running API regression tests.`);
  testProcess = spawn(process.execPath, ["--import", "tsx", "--test", "tests/integration/api.test.mjs"], {
    stdio: "inherit", env: { ...process.env, TEST_MYSQL_URL: `mysql://root@127.0.0.1:${port}/zhiwen_test` }, timeout: 120000,
  });
  const [code] = await once(testProcess, "exit");
  process.exitCode = code ?? 1;
} catch (error) {
  console.error(error.message);
  for (const file of ["init.log", "mysql.log"]) {
    const log = await fs.readFile(path.join(directory, file), "utf8").catch(() => "");
    if (log) console.error(log.split("\n").slice(-15).join("\n"));
  }
  process.exitCode = 1;
} finally {
  if (databaseProcess && databaseProcess.exitCode === null && databaseProcess.signalCode === null) {
    databaseProcess.kill("SIGTERM");
    const timer = setTimeout(() => databaseProcess.kill("SIGKILL"), 10000);
    timer.unref();
    await databaseExit;
    clearTimeout(timer);
  }
  // Only the directory created by this invocation is removed.
  await fs.rm(directory, { recursive: true, force: true });
  console.log("Temporary MySQL files cleaned up.");
}
