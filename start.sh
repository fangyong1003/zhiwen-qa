#!/usr/bin/env bash
# 一键启动本地开发环境：MySQL → 数据表 → 后端 → 前端。
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail

task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$task_root"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  printf '%s\n' \
    '用法：./start.sh [--check]' \
    '默认读取项目 .env，启动本机 Homebrew MySQL、后端和前端。' \
    '--check 只检查配置和当前服务，不安装依赖、不启动服务、不改数据库。' \
    '可选：WEB_PORT=3001 ./start.sh；MYSQL_SERVICE=mysql@8.4 ./start.sh' \
    'Ctrl+C 只停止本次新启动的前后端，保留 MySQL 和之前已有的服务。'
  exit 0
fi
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--check" ]; }; then
  printf '%s\n' '未知参数，请运行 ./start.sh --help。' >&2
  exit 1
fi

fail() { printf '\n错误：%s\n' "$*" >&2; exit 1; }
for task_command in node npm lsof; do
  command -v "$task_command" >/dev/null 2>&1 || fail "找不到 $task_command，请先安装并加入 PATH。"
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)' \
  || fail '需要 Node.js 22.13 或更新版本。'
[ -f .env ] || fail '缺少 .env。请先复制 .env.example 为 .env，并填写 MYSQL_URL、JWT_SECRET 和 GEMINI_API_KEY。'
if [ ! -x node_modules/.bin/tsx ] || [ ! -x node_modules/.bin/vite ]; then
  [ "${1:-}" != "--check" ] || fail '依赖未安装，请先运行 npm ci 或直接运行 ./start.sh。'
  printf '\n正在安装项目依赖…\n'
  npm ci
fi

# 通过 dotenv 读取配置，不用 source 执行 .env，也不把密码放进命令参数或输出。
dev_helper() {
  node --import tsx --input-type=module - "$@" <<'NODE'
import mysql from "mysql2/promise";

const [action, kind, port] = process.argv.slice(2);
async function main() {
  const { config } = await import("./server/config.ts");
  const endpoint = new URL(config.MYSQL_URL);
  if (endpoint.protocol !== "mysql:" || !endpoint.hostname || !endpoint.pathname.slice(1)) throw new Error("MYSQL_CONFIG");
  const host = endpoint.hostname.replace(/^\[|\]$/g, "");
  const database = decodeURIComponent(endpoint.pathname.slice(1));
  const mysqlPort = Number(endpoint.port || 3306);
  const webPort = Number(process.env.WEB_PORT || 3000);
  if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535 || webPort === config.PORT) throw new Error("WEB_PORT_CONFIG");
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);

  if (action === "settings") {
    console.log([config.PORT, webPort, local ? "local" : "remote", mysqlPort].join(" "));
    return;
  }
  if (action === "http-ready") {
    try {
      const response = await fetch(`http://localhost:${port}${kind === "api" ? "/api/health" : "/"}`, { signal: AbortSignal.timeout(1500) });
      const ready = response.ok && (kind === "api" ? (await response.json()).ok === true : (await response.text()).includes("/@vite/client"));
      process.exitCode = ready ? 0 : 1;
    } catch { process.exitCode = 1; }
    return;
  }
  if (action === "db-probe") {
    endpoint.pathname = "/";
    const connection = await mysql.createConnection({ uri: endpoint.toString(), connectTimeout: 2000 });
    try { await connection.query("SELECT 1"); } finally { await connection.end(); }
    return;
  }
  if (action === "db-ensure") {
    let connection;
    try {
      try {
        connection = await mysql.createConnection({ uri: config.MYSQL_URL, connectTimeout: 2000 });
      } catch (error) {
        if (error.code !== "ER_BAD_DB_ERROR") throw error;
        endpoint.pathname = "/";
        connection = await mysql.createConnection({ uri: endpoint.toString(), connectTimeout: 2000 });
        await connection.query("CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4", [database]);
        console.log("已创建 MYSQL_URL 指定的数据库。");
      }
      await connection.query("SELECT 1");
    } finally { await connection?.end(); }
    return;
  }
  throw new Error("UNKNOWN_ACTION");
}

main().catch((error) => {
  if (action === "db-probe" && ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(error.code)) {
    process.exitCode = 10;
    return;
  }
  if (error.name === "ZodError") {
    console.error("请检查 .env 配置：", error.issues.map((issue) => issue.path.join(".")).join("、"));
  } else if (error.message === "MYSQL_CONFIG" || error.code === "ERR_INVALID_URL") {
    console.error("MYSQL_URL 必须是包含主机和数据库名的有效 mysql:// 连接地址。");
  } else if (error.message === "WEB_PORT_CONFIG") {
    console.error("WEB_PORT 必须在 1–65535 之间，且不能与后端 PORT 相同。");
  } else {
    console.error(`数据库/启动检查失败（${error.code || "UNKNOWN"}），请检查 MYSQL_URL 的地址、账号、密码及数据库权限。`);
  }
  process.exitCode = 1;
});
NODE
}

task_settings="$(dev_helper settings)"
read -r task_api_port task_web_port task_db_location task_db_port <<< "$task_settings"

# 只有工作目录属于本项目且健康检查通过的服务才能复用，不抢占其他项目的端口。
service_state() {
  local kind="$1" port="$2" pids pid directory
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then printf 'start\n'; return; fi
  for pid in $pids; do
    directory="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    [ "$directory" = "$task_root" ] || { printf '端口 %s 已被其他程序占用，请先检查；脚本不会终止它。\n' "$port" >&2; return 1; }
  done
  dev_helper http-ready "$kind" "$port" || { printf '端口 %s 上的项目服务未通过健康检查，请检查原启动终端。\n' "$port" >&2; return 1; }
  printf 'reuse\n'
}

task_api_state="$(service_state api "$task_api_port")"
task_web_state="$(service_state web "$task_web_port")"
if dev_helper db-probe; then task_db_ready=true; else
  task_db_result=$?
  [ "$task_db_result" -eq 10 ] || exit "$task_db_result"
  task_db_ready=false
fi

if [ "${1:-}" = "--check" ]; then
  printf '配置有效；MySQL 可连接：%s；后端 %s：%s；前端 %s：%s\n' "$task_db_ready" "$task_api_port" "$task_api_state" "$task_web_port" "$task_web_state"
  printf '%s\n' 'reuse = 已运行；start = 尚未启动。此检查未修改数据库或服务。'
  exit 0
fi

if [ "$task_db_ready" = true ]; then
  printf '\n[1/4] MySQL 已运行，复用现有连接。\n'
else
  [ "$task_db_location" = local ] || fail '远程 MySQL 无法连接，请先启动远程数据库或检查网络；不会启动无关的本地数据库。'
  [ "$task_db_port" = 3306 ] || fail '当前 MYSQL_URL 不是默认 3306 端口，请先手动启动对应 MySQL，或修正连接端口。'
  command -v brew >/dev/null 2>&1 || fail 'MySQL 未运行且未找到 Homebrew。请先手动启动 MySQL，再运行本脚本。'
  task_mysql_service="${MYSQL_SERVICE:-}"
  if [ -z "$task_mysql_service" ]; then
    task_formulae="$(brew list --formula)"
    for task_formula in $task_formulae; do
      case "$task_formula" in
        mysql|mysql@*)
          [ -z "$task_mysql_service" ] || fail '发现多个 MySQL 版本，请使用 MYSQL_SERVICE=mysql@版本 ./start.sh 指定。'
          task_mysql_service="$task_formula"
          ;;
      esac
    done
  fi
  case "$task_mysql_service" in mysql|mysql@*) ;; *) fail '没有找到 Homebrew MySQL，请先安装 MySQL 或手动启动数据库。' ;; esac
  printf '\n[1/4] 正在启动 MySQL（%s）…\n' "$task_mysql_service"
  # run 只启动本次服务，不新增开机/登录自启动配置。
  brew services run "$task_mysql_service"
  for task_attempt in {1..30}; do
    if dev_helper db-probe; then task_db_ready=true; break; else
      task_db_result=$?
      [ "$task_db_result" -eq 10 ] || exit "$task_db_result"
    fi
    sleep 1
  done
  [ "$task_db_ready" = true ] || fail 'MySQL 启动后仍无法连接，请检查 brew services list 和 MYSQL_URL。'
fi

printf '\n[2/4] 检查数据库并初始化数据表…\n'
dev_helper db-ensure
npm run db:init

# 为每个新服务创建独立进程组，退出时连同 tsx watch 子进程一起清理。
set -m
task_child_pids=""
cleanup() {
  trap - EXIT INT TERM
  [ -n "$task_child_pids" ] || return 0
  printf '\n正在停止本次启动的前后端；MySQL 和原有服务保持运行。\n'
  for task_pid in $task_child_pids; do kill -TERM -- "-$task_pid" 2>/dev/null || true; done
  for task_attempt in {1..50}; do
    task_live=false
    for task_pid in $task_child_pids; do if kill -0 -- "-$task_pid" 2>/dev/null; then task_live=true; fi; done
    [ "$task_live" = true ] || break
    sleep 0.1
  done
  for task_pid in $task_child_pids; do
    kill -KILL -- "-$task_pid" 2>/dev/null || true
    wait "$task_pid" 2>/dev/null || true
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_service() {
  local kind="$1" port="$2" pid="$3"
  for task_attempt in {1..30}; do
    kill -0 "$pid" 2>/dev/null || fail "$kind 启动进程已退出，请查看上方日志。"
    if dev_helper http-ready "$kind" "$port"; then return; fi
    sleep 1
  done
  fail "$kind 未能在预期时间内启动，请查看上方日志。"
}

if [ "$task_api_state" = reuse ]; then
  printf '\n[3/4] 后端已运行：http://localhost:%s\n' "$task_api_port"
else
  printf '\n[3/4] 正在启动后端…\n'
  NODE_ENV=development node_modules/.bin/tsx watch server/index.ts &
  task_pid=$!; task_child_pids="$task_child_pids $task_pid"
  wait_for_service api "$task_api_port" "$task_pid"
fi
if [ "$task_web_state" = reuse ]; then
  printf '\n[4/4] 前端已运行：http://localhost:%s\n' "$task_web_port"
else
  printf '\n[4/4] 正在启动前端…\n'
  NODE_ENV=development node_modules/.bin/vite --host 0.0.0.0 --port "$task_web_port" --strictPort &
  task_pid=$!; task_child_pids="$task_child_pids $task_pid"
  wait_for_service web "$task_web_port" "$task_pid"
fi

printf '\n启动完成！浏览器打开：http://localhost:%s\n' "$task_web_port"
if [ -z "$task_child_pids" ]; then
  printf '%s\n' '前后端原本就已运行，没有重复启动。请在原终端管理这些服务。'
  exit 0
fi
printf '%s\n' '保持此终端打开；按 Ctrl+C 停止本次新启动的前后端。'
while :; do
  for task_pid in $task_child_pids; do
    if ! kill -0 "$task_pid" 2>/dev/null; then
      printf '\n一个开发服务已退出，正在结束本次启动。\n' >&2
      if wait "$task_pid"; then exit 0; else exit "$?"; fi
    fi
  done
  sleep 1
done
