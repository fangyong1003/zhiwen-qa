# 知问 · 内部 AI 知识助手

本地运行的内部知识问答系统，支持普通员工和管理员账号、MySQL 数据管理、资料上传、向量检索、带引用的问答、会话历史、反馈和审计记录。

## 开始使用

```bash
npm install
cp .env.example .env
# 编辑 .env，填写 MYSQL_URL、JWT_SECRET、OPENAI_API_KEY、DEEPSEEK_API_KEY
docker compose up -d mysql # 如已有 MySQL，可跳过此步骤
npm run db:init
npm run dev
```

浏览器打开 `http://localhost:3000`。首次启动可用 `.env` 中的 `ADMIN_*` 自动创建管理员；若未填写，也可在登录页创建第一个管理员。

## 主要能力

- 管理员与普通员工两种角色，以及 HTTP-only 会话登录。
- PDF、DOCX、XLSX/XLS 和 TXT 本地上传、文本解析和索引。
- 使用 OpenAI Embedding 生成向量，在 MySQL 中保存知识片段与向量。
- 向量相似度与关键词融合的本地重排序；问答可选择 OpenAI 或 DeepSeek。
- 流式回答、来源引用下载、会话历史、回答反馈和审计记录。

上传文件保存在 `uploads/`，MySQL 保存全部业务数据。密钥只应存入本地 `.env`，不要提交到 Git。

如果使用随项目提供的 MySQL 容器，请让 `MYSQL_URL` 内的用户名、密码和数据库名与 `MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE` 保持一致。
