import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveRuntimePaths, resolveBrowserLaunchOptions } from "../lib/runtime-paths.ts";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

test("未设置环境变量时保持项目目录和本机 Edge", () => {
  assert.deepEqual(resolveRuntimePaths({}), {
    projectRoot,
    dataRoot: projectRoot,
    outputDir: path.join(projectRoot, "output"),
  });
  assert.deepEqual(resolveBrowserLaunchOptions({}), { channel: "msedge" });
});

test("用户数据目录独立于程序目录，支持含空格的绝对路径", () => {
  const root = path.resolve(os.tmpdir(), "Xinle Portable App");
  const dataRoot = path.resolve(os.tmpdir(), "Xinle User Data");
  assert.deepEqual(resolveRuntimePaths({ XINLE_DATA_DIR: dataRoot }, root), {
    projectRoot: root,
    dataRoot,
    outputDir: path.join(dataRoot, "output"),
  });
  assert.equal(resolveRuntimePaths({ XINLE_DATA_DIR: "user-data" }, root).dataRoot, path.join(root, "user-data"));
});

test("显式浏览器路径优先且不同时设置 Edge channel", () => {
  const root = path.resolve(os.tmpdir(), "Xinle Portable App");
  const chrome = path.join(root, "browser", "chrome-win64", "chrome.exe");
  assert.deepEqual(resolveBrowserLaunchOptions({ XINLE_BROWSER_PATH: chrome }), { executablePath: chrome });
  assert.deepEqual(resolveBrowserLaunchOptions({ XINLE_BROWSER_PATH: "browser/chrome.exe" }, root), { executablePath: path.join(root, "browser", "chrome.exe") });
  assert.deepEqual(resolveBrowserLaunchOptions({ XINLE_BROWSER_PATH: "  " }), { channel: "msedge" });
});

test("PORT=0 输出实际监听端口，用户目录不读取项目凭据且网页仍来自程序目录", { timeout: 15_000 }, async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "xinle-portable-runtime-"));
  const child = spawn(process.execPath, ["server.ts"], {
    cwd: projectRoot,
    windowsHide: true,
    env: { ...process.env, PORT: "0", XINLE_DATA_DIR: dataRoot, XINLE_USERNAME: "", XINLE_PASSWORD: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  t.after(async () => {
    child.kill();
    await exited;
    await rm(dataRoot, { recursive: true, force: true });
  });
  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("服务没有输出实际监听端口")), 8_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  assert.ok(port > 0 && port <= 65535);
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(base + "/api/prices")).status, 404);
  assert.deepEqual(await (await fetch(base + "/api/login-config")).json(), { username: "", hasPassword: false });
});
