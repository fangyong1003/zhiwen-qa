import bcrypt from "bcryptjs";
import type { NextFunction, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config";
import { appUserByEmail, appUserById, toAppUser } from "./db";
import type { AppUser, AuthedRequest } from "./types";

const COOKIE_NAME = "zhiwen_session";

export function issueSession(response: Response, user: AppUser) {
  const token = jwt.sign(user, config.JWT_SECRET, { expiresIn: "7d" });
  response.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearSession(response: Response) {
  response.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
}

export async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  const authorization = req.header("authorization");
  const token = req.cookies?.[COOKIE_NAME] ?? (authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined);
  if (!token) return res.status(401).json({ error: "请先登录" });
  let userId: number;
  try {
    const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] });
    if (typeof payload === "string" || !Number.isSafeInteger(payload.id) || payload.id <= 0) {
      return res.status(401).json({ error: "登录凭证无效，请重新登录" });
    }
    userId = payload.id;
  } catch {
    return res.status(401).json({ error: "登录已过期，请重新登录" });
  }
  try {
    const row = await appUserById(userId);
    if (!row || !row.is_active) {
      clearSession(res);
      return res.status(401).json({ error: "账号已停用或不存在，请联系管理员" });
    }
    req.user = toAppUser(row);
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "仅管理员可以执行此操作" });
  return next();
}

export async function verifyPassword(email: string, password: string) {
  const row = await appUserByEmail(email);
  if (!row || !row.is_active || !(await bcrypt.compare(password, row.password_hash))) return null;
  return toAppUser(row);
}
