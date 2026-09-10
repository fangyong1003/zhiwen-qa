import type { Request } from "express";
export type { Citation } from "../shared/citations";

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
