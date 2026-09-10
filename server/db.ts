import bcrypt from "bcryptjs";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { config } from "./config";
import type { AppUser, Role } from "./types";

export const db = mysql.createPool({
  uri: config.MYSQL_URL,
  connectionLimit: 10,
  namedPlaceholders: true,
  charset: "utf8mb4",
});

const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(191) NOT NULL UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('employee', 'admin') NOT NULL DEFAULT 'employee',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS documents (
    id CHAR(36) NOT NULL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(120) NOT NULL,
    storage_path VARCHAR(500) NOT NULL,
    content MEDIUMTEXT NOT NULL,
    size_bytes BIGINT UNSIGNED NOT NULL,
    status ENUM('processing', 'ready', 'failed') NOT NULL DEFAULT 'processing',
    error_message TEXT NULL,
    uploaded_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_documents_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_documents_status_updated (status, updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS document_chunks (
    id CHAR(36) NOT NULL PRIMARY KEY,
    document_id CHAR(36) NOT NULL,
    chunk_index INT UNSIGNED NOT NULL,
    content MEDIUMTEXT NOT NULL,
    embedding JSON NOT NULL,
    embedding_space VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_chunks_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    UNIQUE KEY uq_document_chunk (document_id, chunk_index),
    INDEX idx_chunks_document (document_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id CHAR(36) NOT NULL PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    title VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_conversations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_conversations_user_updated (user_id, updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS messages (
    id CHAR(36) NOT NULL PRIMARY KEY,
    sequence_no BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    conversation_id CHAR(36) NOT NULL,
    role ENUM('user', 'assistant') NOT NULL,
    content MEDIUMTEXT NOT NULL,
    provider ENUM('openai', 'deepseek', 'gemini') NULL,
    citations JSON NULL,
    web_search BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    UNIQUE KEY uq_messages_sequence (sequence_no),
    INDEX idx_messages_conversation_created (conversation_id, created_at, sequence_no)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS feedback (
    id CHAR(36) NOT NULL PRIMARY KEY,
    message_id CHAR(36) NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    rating ENUM('up', 'down') NOT NULL,
    note VARCHAR(1000) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_feedback_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    CONSTRAINT fk_feedback_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_feedback_once (message_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS conversation_attachments (
    id CHAR(36) NOT NULL PRIMARY KEY,
    conversation_id CHAR(36) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    storage_path VARCHAR(500) NOT NULL,
    size_bytes BIGINT UNSIGNED NOT NULL,
    status ENUM('parsing','indexing','ready','failed') NOT NULL DEFAULT 'parsing',
    content MEDIUMTEXT NULL,
    error_message VARCHAR(1000) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_attachments_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    INDEX idx_attachments_conversation (conversation_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS attachment_chunks (
    id CHAR(36) NOT NULL PRIMARY KEY,
    attachment_id CHAR(36) NOT NULL,
    chunk_index INT UNSIGNED NOT NULL,
    content TEXT NOT NULL,
    embedding JSON NOT NULL,
    embedding_space VARCHAR(255) NOT NULL,
    CONSTRAINT fk_private_chunks_attachment FOREIGN KEY (attachment_id) REFERENCES conversation_attachments(id) ON DELETE CASCADE,
    UNIQUE KEY uq_attachment_chunk (attachment_id, chunk_index)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS conversation_turns (
    id CHAR(36) NOT NULL PRIMARY KEY,
    run_token CHAR(36) NULL,
    conversation_id CHAR(36) NOT NULL,
    user_message_id CHAR(36) NOT NULL,
    assistant_message_id CHAR(36) NULL,
    request JSON NOT NULL,
    status ENUM('running','completed','failed','cancelled') NOT NULL DEFAULT 'running',
    partial_content MEDIUMTEXT NOT NULL,
    error_message VARCHAR(1000) NULL,
    error_code VARCHAR(50) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_turn_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    UNIQUE KEY uq_turn_user_message (user_message_id),
    UNIQUE KEY uq_turn_assistant_message (assistant_message_id),
    INDEX idx_turn_conversation (conversation_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id CHAR(36) NOT NULL PRIMARY KEY,
    user_id BIGINT UNSIGNED NULL,
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(80) NULL,
    target_id VARCHAR(100) NULL,
    detail JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_audit_created (created_at),
    INDEX idx_audit_user_created (user_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

export async function ensureDatabase() {
  for (const statement of schema) await db.query(statement);
  const [turnColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM conversation_turns LIKE 'run_token'");
  if (!turnColumns.length) {
    try { await db.query("ALTER TABLE conversation_turns ADD COLUMN run_token CHAR(36) NULL"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ER_DUP_FIELDNAME")) throw error; }
  }
  for (const [name, definition] of [
    ["active_request_id", "CHAR(36) NULL"], ["active_until", "DATETIME NULL"],
    ["context_summary", "TEXT NULL"], ["summary_through", "BIGINT UNSIGNED NOT NULL DEFAULT 0"],
    ["context_reset_sequence", "BIGINT UNSIGNED NOT NULL DEFAULT 0"],
  ]) {
    const [columns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM conversations LIKE ?", [name]);
    if (!columns.length) {
      try { await db.query(`ALTER TABLE conversations ADD COLUMN ${name} ${definition}`); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ER_DUP_FIELDNAME")) throw error; }
    }
  }
  const [searchColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM messages LIKE 'web_search'");
  if (!searchColumns.length) {
    try {
      await db.query("ALTER TABLE messages ADD COLUMN web_search BOOLEAN NOT NULL DEFAULT FALSE");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ER_DUP_FIELDNAME")) throw error;
    }
  }
  const [embeddingColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM document_chunks LIKE 'embedding_space'");
  if (!embeddingColumns.length) {
    try {
      // Existing vectors deliberately remain unlabelled: never assume their model or dimensions.
      await db.query("ALTER TABLE document_chunks ADD COLUMN embedding_space VARCHAR(255) NULL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ER_DUP_FIELDNAME")) throw error;
    }
  }
  const [providerColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM messages LIKE 'provider'");
  if (providerColumns[0].Type === "enum('openai','deepseek')") {
    await db.query("ALTER TABLE messages MODIFY COLUMN provider ENUM('openai', 'deepseek', 'gemini') NULL");
  }
  const [sequenceColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM messages LIKE 'sequence_no'");
  if (!sequenceColumns.length) {
    try {
      await db.query("ALTER TABLE messages ADD COLUMN sequence_no BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, ADD UNIQUE KEY uq_messages_sequence (sequence_no)");
    } catch (error) {
      // Another starting process may have applied the same atomic migration already.
      if (!(error instanceof Error && "code" in error && error.code === "ER_DUP_FIELDNAME")) throw error;
    }
  }
  const [rows] = await db.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM users");
  if (Number(rows[0].count) === 0 && config.ADMIN_EMAIL && config.ADMIN_PASSWORD) {
    const passwordHash = await bcrypt.hash(config.ADMIN_PASSWORD, 12);
    await db.execute(
      "INSERT INTO users (email, display_name, password_hash, role) VALUES (?, ?, ?, 'admin')",
      [config.ADMIN_EMAIL.toLowerCase(), config.ADMIN_NAME, passwordHash],
    );
    console.log(`已创建初始管理员：${config.ADMIN_EMAIL}`);
  }
}

export async function appUserByEmail(email: string) {
  const [rows] = await db.execute<RowDataPacket[]>(
    "SELECT id, email, display_name, role, password_hash, is_active FROM users WHERE email = ? LIMIT 1",
    [email.toLowerCase()],
  );
  return rows[0] as (RowDataPacket & { password_hash: string; is_active: number }) | undefined;
}

export async function appUserById(id: number) {
  const [rows] = await db.execute<RowDataPacket[]>(
    "SELECT id, email, display_name, role, is_active FROM users WHERE id = ? LIMIT 1",
    [id],
  );
  return rows[0];
}

export function toAppUser(row: RowDataPacket): AppUser {
  return { id: Number(row.id), email: row.email, displayName: row.display_name, role: row.role as Role };
}

export async function countUsers() {
  const [rows] = await db.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM users");
  return Number(rows[0].count);
}
