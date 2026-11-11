import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import path from "node:path";
import { resolveRuntimePaths } from "./runtime-paths.ts";

type Credentials = { username: string; password: string };

function validate(username: unknown, password: unknown): Credentials {
  if (typeof username !== "string" || !username.trim() || username.trim().length > 128 || /[\r\n\0]/.test(username)) {
    throw new Error("请输入有效账号（不超过 128 个字符）。");
  }
  if (typeof password !== "string" || password.length === 0 || password.length > 1024 || /[\r\n\0]/.test(password)) {
    throw new Error("请输入有效密码（不超过 1024 个字符，不能包含换行）。");
  }
  return { username: username.trim(), password };
}

/** 每次重新读文件，已保存的网页配置优先于旧环境变量，不缓存密码。 */
export function readLoginCredentials(
  rootDir = resolveRuntimePaths().dataRoot,
  environment: Record<string, string | undefined> = process.env,
): Credentials {
  let raw: string | undefined;
  try { raw = readFileSync(path.join(rootDir, "config", "login.json"), "utf8"); }
  catch (error: any) { if (error.code !== "ENOENT") throw new Error("无法读取登录配置。"); }
  if (raw !== undefined) {
    try {
      const data = JSON.parse(raw);
      return validate(data.username, data.password);
    } catch { throw new Error("已保存的登录配置无效，请重新填写并保存。"); }
  }
  let local: Record<string, string> = {};
  try { local = parseEnv(readFileSync(path.join(rootDir, ".env.local"), "utf8")); }
  catch (error: any) { if (error.code !== "ENOENT") throw new Error("无法读取原有登录配置。"); }
  return {
    username: environment.XINLE_USERNAME ?? local.XINLE_USERNAME ?? "",
    password: environment.XINLE_PASSWORD ?? local.XINLE_PASSWORD ?? "",
  };
}

export function getLoginConfigMetadata(rootDir = resolveRuntimePaths().dataRoot) {
  const credentials = readLoginCredentials(rootDir);
  return { username: credentials.username, hasPassword: credentials.password.length > 0 };
}

export async function saveLoginConfig(input: unknown, rootDir = resolveRuntimePaths().dataRoot) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("登录配置格式不正确。");
  const values = input as Record<string, unknown>;
  let password = values.password;
  if (password === "" || password === undefined) password = readLoginCredentials(rootDir).password;
  const credentials = validate(values.username, password);
  const directory = path.join(rootDir, "config");
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, "login.json");
  const temporary = path.join(directory, `login.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ ...credentials, updatedAt: new Date().toISOString() }, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return { username: credentials.username, hasPassword: true };
}
