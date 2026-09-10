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

关闭本机 Homebrew MySQL：

```bash
./stop-mysql.sh
```

脚本直接执行 `brew services stop mysql`，不删除数据库文件，也不关闭前后端进程；所有连接该 MySQL 的项目都会受影响，同时取消该服务的登录自启动。

使用 Docker、非默认端口或远程 MySQL 时，请先启动对应数据库，再运行 `./start.sh`，启动脚本会直接连接并复用；只有默认本地 3306 端口连接失败时才尝试 Homebrew 启动。也可以继续逐项手动启动：

```bash
npm install
cp .env.example .env
# 编辑 .env，填写 MYSQL_URL、JWT_SECRET、GEMINI_API_KEY
docker compose up -d mysql # 如已有 MySQL，可跳过此步骤
npm run db:init
npm run dev
```

浏览器打开 `http://localhost:3000`。首次启动可用 `.env` 中的 `ADMIN_*` 自动创建管理员；若未填写，也可在登录页创建第一个管理员。

`./start.sh` 和 `npm run dev` 均使用 `vite --host 0.0.0.0`，前端监听所有 IPv4 网卡。同一局域网的设备可通过 `http://<本机局域网 IP>:3000` 访问（使用 `WEB_PORT` 时替换端口），API 请求仍由前端开发服务器代理到后端。已有前端进程需在原终端停止后重新启动才能应用该参数，一键脚本复用旧进程时不会修改监听地址。请仅在可信网络使用，不要将 Vite 开发服务器直接暴露到公网。

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

修改 `.env` 后重启后端。已有 `.env` 未填写向量配置时，默认使用 `gemini-embedding-2`、768 维；旧的 `OPENAI_EMBEDDING_MODEL` 不再使用。密钥不下发到浏览器，`GEMINI_BASE_URL` 同时用于 Gemini 问答、向量和联网搜索请求。

文档和问题通过 `models.embedContent` 使用同一向量模型与维度。默认 Embedding 2 使用文档格式和问答检索前缀，每个片段单独生成向量，每批最多 64 个片段。也支持配置 `gemini-embedding-001`，自动改用 `RETRIEVAL_DOCUMENT` / `QUESTION_ANSWERING` 任务类型。维度支持 128–3072，默认 768；服务端校验数量、维度和数值，并归一化后存储。

升级已有知识库时，先备份数据库和 `uploads/`，执行 `npm run db:init`，再重启后端。旧向量会保留，但不会被当作 Gemini 向量使用。请管理员在「知识库管理」对已有资料逐一点击「重建索引」，无需重新上传；这会将文档文本发送到配置的 Gemini 服务，并产生对应调用用量。全部旧索引重建完成后再提问。之后更改向量模型或维度也需要重建；只切换问答模型不需要。发现未标记、不同配置或损坏的向量时，系统会指出需要重建的文档并停止检索，避免混用导致错误结果。

参考：[Google JavaScript SDK](https://googleapis.github.io/js-genai/release_docs/index.html)、[流式生成接口](https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent)、[Gemini Embedding 文档](https://ai.google.dev/gemini-api/docs/embeddings)、[Gemini 3.8 Flash 模型说明](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)。

## DeepSeek 配置

按 DeepSeek 官方文档使用 OpenAI 兼容的 Chat Completions 接口，服务端默认请求 `https://api.deepseek.com/chat/completions`，使用 Bearer 密钥认证和 SSE 流式输出，无需额外安装 SDK。

```dotenv
DEEPSEEK_API_KEY=填写你的服务端密钥
DEEPSEEK_CHAT_MODEL=deepseek-v4-flash
# 可选：留空使用官方地址；仅填写可信服务端代理，支持带 /v1 的地址。
DEEPSEEK_BASE_URL=
```

修改本地 `.env` 后重启后端，在输入框模型菜单选择「DeepSeek」。Gemini 仍是首次进入、新建对话和 API 未指定模型时的默认选项。DeepSeek 可通过 `DEEPSEEK_CHAT_MODEL` 改为 `deepseek-v4-pro`，以实际账号支持的模型为准；本项目知识库问答明确使用非思考模式 `thinking.type=disabled`，单次输出上限 4096 token，总请求时限 60 秒，不自动重试。

系统指令、检索片段和最近对话会传给所选 DeepSeek 服务，只有最终回答文本会展示及保存，不包含 `reasoning_content`。完成标记、空响应、生成中断、长度上限、余额不足（402）、认证失败、限流（429）和服务繁忙分别处理；失败不会写入成功的助手消息。密钥仅留在服务端，不写入配置模板或前端。

**切换 DeepSeek 不会替换向量检索或联网搜索。** 文档/问题向量和可选 Google 搜索仍使用 Gemini，需要有效的 `GEMINI_API_KEY`；Google 搜索限额错误仍需单独处理，或关闭「联网搜索」。切换问答模型不需要重建文档索引。

参考：[首次调用 API](https://api-docs.deepseek.com/zh-cn/)、[Chat Completions 参数及流式协议](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)、[错误码](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes/)。

## 问答与联网搜索

输入框下方可勾选「联网搜索」，默认关闭，新建对话后恢复关闭。Enter 直接发送，Shift+Enter 换行；中文输入法确认候选词不会发送，生成过程中会锁定发送和搜索选项，避免重复请求。

「知识库来源」只显示回答实际标注引用编号的资料，不把检索候选全部列出。没有有效引用时，标题和卡片整体隐藏；仅有联网补充时只展示网页来源。来源编号保持与回答一致，例如只引用 `[2]` 时仍显示 `[2]`。新回答只保存实际使用的引用；旧历史在读取时按同样规则筛选，不改写原有回答或数据库记录。模型被明确要求忽略不相关资料，资料不足时不要列出参考来源。

每条回答只可成功评价一次「有帮助」或「不准确」。提交时会显示状态并暂时禁用两个选项；成功后高亮所选项、显示「已评价」并锁定，刷新或重新打开对话仍保留。后端通过现有唯一约束保留第一次成功评价，重复或并发请求不会覆盖原选择；评价与审计记录在同一事务内保存。失败会在对应回答下提示，允许重试；网络中断后重试若发现已保存，会恢复服务端原有选择。已有评价也视为已完成，无需修改数据表。

- 关闭时，按「回答依据」检索公司知识库、会话附件或两者，不调用 Google 搜索。
- 开启时，使用现有 `GEMINI_API_KEY`、`GEMINI_CHAT_MODEL` 和 `GEMINI_BASE_URL` 调用 Google Search grounding，无需新增搜索密钥。所配模型及代理必须支持 `googleSearch` 工具；未支持、权限不足或限额时会显示错误，不会静默当成已搜索。
- 知识库回答继续使用下拉框选定的模型。公开网页回答单独显示为「联网补充」，保留 Google 的原始回答、网页来源和搜索建议，不交给其他模型改写。
- 搜索请求只包含当前问题，不附带知识库片段或历史聊天。问题仍会发送给配置的 Gemini / Google 服务，请勿在开启联网时输入机密内容。搜索可能产生额外用量。
- 联网补充仅在当前页面本次请求中展示，不存入数据库、知识库或后续模型上下文；刷新或重新打开历史后不可恢复。历史只保存知识库回答、内部引用及本轮是否开启联网。如果服务没有返回可引用网页，页面会明确提示本次未获得网页结果。

重启后端或执行 `npm run db:init` 会为 `messages` 表增加默认关闭的 `web_search` 字段，保留已有数据；本次更新无需重建文档向量。Google 接入方式与展示约束见 [Google Search grounding 文档](https://ai.google.dev/gemini-api/docs/google-search)及 [Gemini API 使用条款](https://ai.google.dev/gemini-api/terms)。

## 多轮问答、私有附件与上下文压缩

聊天页支持上传本人当前会话的 PDF、DOCX、XLSX、XLS、UTF-8 TXT，并选择「仅公司知识库」「仅会话附件」或「附件＋公司知识库」。附件在服务器持久保存，重新打开该会话后仍可追问；不加入共享知识库，其他员工和管理员账号均不能通过问答、列表或下载接口访问。这里的“私有”指应用内访问隔离：解析文本仍会发送到配置的 Gemini 服务建立向量，相关片段、历史和摘要会交给所选问答模型。联网搜索只接收当前原始问题，不接收附件、改写问题或历史。

- 单文件最多 10 MiB，每会话最多 5 个附件，每用户附件原文件总量最多 100 MiB。每个应用进程同时最多处理 4 个附件。
- 上传后显示解析、索引、就绪或失败状态。尚未就绪的附件不能用于提问；失败可重试解析，不用重复上传。开始聊天后资料区默认收起，可展开查看文件和切换范围。
- 文件扩展名与内容校验结合；Office ZIP 限制条目和展开大小。解析在带堆内存限制的 Worker 中执行，20 秒超时；解析与索引合计最多 3 分钟。这不是完整恶意文件沙箱或杀毒系统；扫描 PDF/OCR、图片理解、复杂表格计算仍未实现。
- 原文件位于非公开静态目录 `uploads/private/`，文件权限为 `600`。目前保留到用户主动删除，没有自动到期清理。删除会移除原文件和索引、清空本会话摘要并让删除前的消息退出后续模型上下文；已生成的历史回答仍保留，原附件下载失效。
- 追问会结合历史和附件名补齐指代再检索；无法确定指代时返回澄清问题。默认模型仍为 Gemini，不新增具体模型版本选择器。

上下文采用“滚动摘要＋近期消息＋本轮相关片段”，不会每轮发送整段历史或整个附件：

1. 未摘要的历史超过 8 条消息或约 10,000 UTF-8 字节时，调用当前问答模型整理较早内容；保留最近 6 条消息，摘要最多 4,000 UTF-8 字节。
2. 摘要提示要求保留用户事实、约束、数字、日期和未解决问题，并标记旧回答的说法；摘要只辅助理解，不替代本轮资料来源。失败、取消的轮次不参与后续历史或摘要。
3. 默认 `CHAT_CONTEXT_TOKENS=24000`，支持 16000–64000。该值是按 UTF-8 字节保守估算的输入预算，不是供应商 tokenizer 的精确计数，也不是实际账单用量。最终输入还会限制近期消息、裁剪检索片段并预留协议开销，仍超预算时明确报错。
4. 摘要保存在会话表中，页面显示“较早的对话已压缩为摘要”。原始聊天记录不会因压缩被删除。摘要生成和必要的追问改写可能增加模型调用；实际节省和记忆准确性需用真实长对话评估。

这是有损压缩：单次整理只读取最近 100 条未摘要消息，并限制每条旧消息及摘要输入长度。尤其迁移进来的超长旧会话不能保证每个细节都进入摘要；关键业务结论仍应回看原文，必要时重新明确约束。

## 停止生成与失败恢复

生成时展示上下文整理、检索、搜索和回答阶段，可点击「停止生成」。未完成文字单独保存为失败或取消状态，不当成成功回答、不可评价，也不进入后续上下文。断开连接会触发取消；总处理时限为 3 分钟，崩溃留下的生成占用最多 4 分钟后可恢复。同一会话同时只允许一轮增强问答生成，期间禁止修改附件。

「重试此问题」复用同一问题编号和用户消息，已完成请求重放不会再次调用模型。只有最后一个问题可以原地重试；继续过对话后，旧问题需要作为新问题发送。联网失败时可以选择「关闭联网并继续」，不会静默降级。重试未完成请求仍可能产生新的模型用量；停止只取消客户端连接和后续处理，无法保证供应商终止已经执行的工作或撤销计费。

新前端在 `POST /api/chat/stream` 中传入 `requestId`、`conversationId`（UUID）、`question`、`provider`、`webSearch`、`scope`、`attachmentIds`。先通过 `POST /api/conversations` 创建草稿，附件接口位于 `/api/conversations/:id/attachments`，状态接口为 `/api/conversations/:id/turns`，取消接口为 `POST /api/chat/turns/:requestId/cancel`。重试必须复用原编号及参数，只有搜索失败允许将 `webSearch` 从 `true` 改为 `false`。

不带 `requestId` 的旧接口暂留兼容，不提供本节增强能力，也不能继续已有增强轮次的会话；接入方应升级到新协议。部署前备份数据库和上传目录，然后执行 `npm run db:init` 并重启后端。升级会保留旧数据，新增会话摘要、生成占用元数据及附件、片段和轮次表，无需重建现有共享向量。

设计参考：[OpenAI 流式响应说明](https://developers.openai.com/api/docs/guides/streaming-responses)、[OWASP 文件上传安全建议](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)。

## 主要能力

- 管理员与普通员工两种角色，以及 HTTP-only 会话登录。
- 账号停用和角色变更在下一次请求生效；系统保留至少一位有效管理员。
- PDF、DOCX、XLSX/XLS 和 TXT 本地上传、文本解析和索引。
- 使用 Gemini Embedding 生成文档和问题向量，在 MySQL 中保存知识片段、向量和模型配置标记。
- 向量相似度与关键词融合的本地重排序；问答默认 Gemini，可切换 OpenAI 或 DeepSeek。
- 流式回答、来源引用下载、会话历史、回答反馈和审计记录。
- 自主开启 Google 联网搜索，公开网页补充与内部知识来源分开展示。
- 会话私有附件、追问指代补全、滚动上下文摘要、停止生成及原问题重试。

上传文件保存在 `uploads/`，MySQL 保存全部业务数据。密钥只应存入本地 `.env`，不要提交到 Git。

当前知识库按全员共享管理：有效账号可检索和下载全部就绪资料，管理员负责上传与维护。部门或文档级授权仍在计划中。索引失败的资料会保留原文件与失败原因，可在知识库管理中重建索引。

启动或执行 `db:init` 时会为旧版 `messages` 表补充消息排序列、联网选择字段，扩展 `provider` 枚举以保存 Gemini 回答，并为 `document_chunks` 添加 `embedding_space` 向量配置标记。数据库账号需要 `ALTER` 权限；升级已有环境前应先备份。已有对话记录与文件保留，旧向量不自动重新生成。新消息按写入顺序解决同秒排序问题，旧数据仍优先按原时间排序，原先同秒记录的真实先后顺序无法追溯。

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

该命令使用临时目录、随机端口和独立 MySQL 实例，不依赖项目 `.env`，结束时停止实例并清理测试文件。覆盖一键启动脚本的建库、前后端启动/复用/退出与端口冲突保护，以及账号初始化与登录、权限变更、仅 Gemini 密钥下的上传/检索/问答、OpenAI/Gemini 流式回答、默认模型、历史引用、反馈、审计、失败重试、旧表升级与向量不兼容保护。还覆盖联网开关、搜索参数校验、模型之间的数据隔离、网页来源安全、搜索失败和结果不落库。模型请求只发送到测试进程创建的本地模拟服务，无需实际模型密钥。

仅检查聊天界面和键盘交互时，可运行 `node tests/helpers/chat-ui-fixture.mjs`，打开终端输出的本地地址。该预览使用内存对话和固定模拟回复，不连接业务数据库，不读取模型密钥，也不执行真实联网搜索；问题包含「无引用」时演示隐藏知识库来源，其余问题演示只显示编号 `[2]` 的已用资料。问题包含「评价失败」时，首次评价会模拟失败；「慢速」会延迟回答供停止/重试测试；开启搜索并输入「联网失败」可验证关闭联网继续。可使用 `tests/fixtures/chat-attachment-*.txt` 演示多文件上传、处理状态和历史恢复（预览不做真实文件索引或下载）。状态只保存在预览进程内，Ctrl+C 关闭预览。

增强问答回归覆盖私有附件隔离、格式检查、索引失败恢复、多文件检索、摘要及输入预算、重开会话追问、同问题防重、取消/断网、失效生成占用恢复、搜索失败继续、删除附件后的索引及记忆清理。真实模型的摘要质量、引用准确性和费用需另行验收。

也可指定专用测试 MySQL 服务：

```bash
TEST_MYSQL_URL='mysql://test-user:test-password@127.0.0.1:3306/zhiwen_test' npm run test:integration
```

测试账号需要建库、删库权限。测试会新建随机名称的 `zhiwen_test_*` 数据库，并仅删除本次创建的库；不要将业务服务作为测试服务。仓库的 GitHub Actions 配置使用 MySQL 8.4 运行这一流程。

## 开发计划

阶段目标、验收标准与实施记录见 [开发与验收计划](docs/WORK_PLAN.md)。
