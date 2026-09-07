import type { Request } from "express";

export type Role = "employee" | "admin";
export type Provider = "openai" | "deepseek" | "gemini";

export interface AppUser {
  id: number;
  email: string;
  displayName: string;
  role: Role;
}

export interface AuthedRequest extends Request {
  user?: AppUser;
}

export interface Citation {
  documentId: string;
  title: string;
  filename: string;
  chunkIndex: number;
  excerpt: string;
  score: number;
}
