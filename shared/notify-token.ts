import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { echoConfigPath, type EchoEnvironment } from "./echo-env.ts";

export const NOTIFY_TOKEN_FILE = "notify-token";

export function notifyTokenPath(env: EchoEnvironment = process.env, homeDir: string = homedir()): string {
  return join(dirname(echoConfigPath(homeDir, env)), NOTIFY_TOKEN_FILE);
}

export function readNotifyToken(env: EchoEnvironment = process.env, homeDir?: string): string | undefined {
  if (env.ECHO_NOTIFY_TOKEN) return env.ECHO_NOTIFY_TOKEN;
  try {
    return readFileSync(notifyTokenPath(env, homeDir), "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function ensureNotifyToken(env: EchoEnvironment = process.env, homeDir?: string): string {
  const existing = readNotifyToken(env, homeDir);
  if (existing) return existing;
  const path = notifyTokenPath(env, homeDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  try {
    writeFileSync(path, `${token}\n`, { mode: 0o600, flag: "wx" });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = readNotifyToken(env, homeDir);
    if (!raced) throw error;
    return raced;
  }
}

export function notifyAuthHeaders(env: EchoEnvironment = process.env): Record<string, string> {
  const token = readNotifyToken(env);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function isAuthorizedNotify(header: string | null, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
