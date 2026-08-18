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
    conversation_id CHAR(36) NOT NULL,
    role ENUM('user', 'assistant') NOT NULL,
    content MEDIUMTEXT NOT NULL,
    provider ENUM('openai', 'deepseek') NULL,
    citations JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    INDEX idx_messages_conversation_created (conversation_id, created_at)
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

export function toAppUser(row: RowDataPacket): AppUser {
  return { id: Number(row.id), email: row.email, displayName: row.display_name, role: row.role as Role };
}

export async function countUsers() {
  const [rows] = await db.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM users");
  return Number(rows[0].count);
}
