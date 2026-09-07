# 知问 · 内部 AI 知识助手

本地运行的内部知识问答系统，支持普通员工和管理员账号、MySQL 数据管理、资料上传、向量检索、带引用的问答、会话历史、反馈和审计记录。

## 开始使用

当前 macOS / Homebrew MySQL 环境可一键启动：

```bash
./start.sh
```

首次使用先将 `.env.example` 复制为 `.env` 并填写配置。脚本会在依赖缺失时运行 `npm ci`，复用已有 MySQL 或启动已安装的 Homebrew MySQL；目标数据库不存在时按 `MYSQL_URL` 创建，再执行 `db:init`、启动后端和前端。脚本不重置密码、不删除数据库、不重建文档向量，也不会新增 MySQL 登录自启动配置。数据库账号需要对应的建库（仅数据库不存在时）、建表和升级权限。

已运行且属于当前项目的前后端会直接复用；其他程序占用端口时会提示退出，不会抢占端口。保持终端打开，按 Ctrl+C 只停止本次启动的前后端，MySQL 和原来已运行的服务保持不变。全部服务原本就已运行时，脚本检查完成后直接退出。复用不会重启原有进程；修改 `.env` 后，请先在原终端停止相关服务，再运行脚本。

```bash
./start.sh --check # 只检查配置、数据库连接和前后端状态，不做启动或初始化
WEB_PORT=3001 ./start.sh # 可选：更换前端端口；后端端口读取 .env 的 PORT
MYSQL_SERVICE=mysql@8.4 ./start.sh # 仅安装多个 Homebrew MySQL 版本时需要指定
```

使用 Docker、非默认端口或远程 MySQL 时，请先启动对应数据库，脚本会直接连接并复用；只有默认本地 3306 端口连接失败时才尝试 Homebrew 启动。也可以继续逐项手动启动：

```bash
npm install
cp .env.example .env
# 编辑 .env，填写 MYSQL_URL、JWT_SECRET、GEMINI_API_KEY
docker compose up -d mysql # 如已有 MySQL，可跳过此步骤
npm run db:init
npm run dev
```

浏览器打开 `http://localhost:3000`。首次启动可用 `.env` 中的 `ADMIN_*` 自动创建管理员；若未填写，也可在登录页创建第一个管理员。

请替换模板中的数据库密码与 JWT 密钥。可以用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成 JWT 密钥。`ADMIN_EMAIL` 与 `ADMIN_PASSWORD` 应同时填写或同时留空。

模型密钥可以暂时留空来验证账号与管理功能。文档索引、问题向量和默认问答统一使用 Gemini，填写 `GEMINI_API_KEY` 即可运行这条完整流程，`OPENAI_API_KEY` 可以留空。仅在选择 OpenAI 或 DeepSeek 回答时，才分别需要额外填写 `OPENAI_API_KEY` 或 `DEEPSEEK_API_KEY`，检索仍使用 Gemini。模型名称应按实际账号可用模型配置。当前项目的自动化测试使用本地模型协议模拟服务，不代表真实模型效果已完成验收。

## Gemini 配置

服务端使用 Google 官方 `@google/genai` SDK 的 `models.generateContentStream` 接口，将系统指令、检索到的资料和最近对话传给 Gemini，并转换为现有 SSE 回答事件。前端首次进入、新建对话以及 API 未指定 `provider` 时均默认选择 Gemini；OpenAI 和 DeepSeek 仍可在模型下拉框中选择。

```dotenv
GEMINI_API_KEY=填写你的服务端密钥
GEMINI_CHAT_MODEL=gemini-3.8-flash
GEMINI_EMBEDDING_MODEL=gemini-embedding-2
GEMINI_EMBEDDING_DIMENSIONS=768
# 使用官方服务时留空；可按需配置服务端代理地址。
GEMINI_BASE_URL=
```

修改 `.env` 后重启后端。已有 `.env` 未填写向量配置时，默认使用 `gemini-embedding-2`、768 维；旧的 `OPENAI_EMBEDDING_MODEL` 不再使用。密钥不下发到浏览器，`GEMINI_BASE_URL` 同时用于 Gemini 问答和向量请求。

文档和问题通过 `models.embedContent` 使用同一向量模型与维度。默认 Embedding 2 使用文档格式和问答检索前缀，每个片段单独生成向量，每批最多 64 个片段。也支持配置 `gemini-embedding-001`，自动改用 `RETRIEVAL_DOCUMENT` / `QUESTION_ANSWERING` 任务类型。维度支持 128–3072，默认 768；服务端校验数量、维度和数值，并归一化后存储。

升级已有知识库时，先备份数据库和 `uploads/`，执行 `npm run db:init`，再重启后端。旧向量会保留，但不会被当作 Gemini 向量使用。请管理员在「知识库管理」对已有资料逐一点击「重建索引」，无需重新上传；这会将文档文本发送到配置的 Gemini 服务，并产生对应调用用量。全部旧索引重建完成后再提问。之后更改向量模型或维度也需要重建；只切换问答模型不需要。发现未标记、不同配置或损坏的向量时，系统会指出需要重建的文档并停止检索，避免混用导致错误结果。

参考：[Google JavaScript SDK](https://googleapis.github.io/js-genai/release_docs/index.html)、[流式生成接口](https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent)、[Gemini Embedding 文档](https://ai.google.dev/gemini-api/docs/embeddings)、[Gemini 3.8 Flash 模型说明](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)。

## 主要能力

- 管理员与普通员工两种角色，以及 HTTP-only 会话登录。
- 账号停用和角色变更在下一次请求生效；系统保留至少一位有效管理员。
- PDF、DOCX、XLSX/XLS 和 TXT 本地上传、文本解析和索引。
- 使用 Gemini Embedding 生成文档和问题向量，在 MySQL 中保存知识片段、向量和模型配置标记。
- 向量相似度与关键词融合的本地重排序；问答默认 Gemini，可切换 OpenAI 或 DeepSeek。
- 流式回答、来源引用下载、会话历史、回答反馈和审计记录。

上传文件保存在 `uploads/`，MySQL 保存全部业务数据。密钥只应存入本地 `.env`，不要提交到 Git。

当前知识库按全员共享管理：有效账号可检索和下载全部就绪资料，管理员负责上传与维护。部门或文档级授权仍在计划中。索引失败的资料会保留原文件与失败原因，可在知识库管理中重建索引。

启动或执行 `db:init` 时会为旧版 `messages` 表补充消息排序列、扩展 `provider` 枚举以保存 Gemini 回答，并为 `document_chunks` 添加 `embedding_space` 向量配置标记。数据库账号需要 `ALTER` 权限；升级已有环境前应先备份。已有对话记录与文件保留，旧向量不自动重新生成。新消息按写入顺序解决同秒排序问题，旧数据仍优先按原时间排序，原先同秒记录的真实先后顺序无法追溯。

如果使用随项目提供的 MySQL 容器，请让 `MYSQL_URL` 内的用户名、密码和数据库名与 `MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE` 保持一致。

## 验证与测试

```bash
npm run check # lint、无数据库单元测试、TypeScript 检查与前端构建
```

如果电脑已安装 MySQL 服务端程序，可以运行完整接口回归：

```bash
npm run test:integration:local
# mysqld 不在 PATH 时：TEST_MYSQLD=/absolute/path/to/mysqld npm run test:integration:local
```

该命令使用临时目录、随机端口和独立 MySQL 实例，不依赖项目 `.env`，结束时停止实例并清理测试文件。覆盖一键启动脚本的建库、前后端启动/复用/退出与端口冲突保护，以及账号初始化与登录、权限变更、仅 Gemini 密钥下的上传/检索/问答、OpenAI/Gemini 流式回答、默认模型、历史引用、反馈、审计、失败重试、旧表升级与向量不兼容保护。模型请求只发送到测试进程创建的本地模拟服务，无需实际模型密钥。

也可指定专用测试 MySQL 服务：

```bash
TEST_MYSQL_URL='mysql://test-user:test-password@127.0.0.1:3306/zhiwen_test' npm run test:integration
```

测试账号需要建库、删库权限。测试会新建随机名称的 `zhiwen_test_*` 数据库，并仅删除本次创建的库；不要将业务服务作为测试服务。仓库的 GitHub Actions 配置使用 MySQL 8.4 运行这一流程。

## 开发计划

阶段目标、验收标准与实施记录见 [开发与验收计划](docs/WORK_PLAN.md)。
