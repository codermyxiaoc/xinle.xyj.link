import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";
import { readLoginCredentials } from "../lib/login-config.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const buildRoot = path.join(root, "build", "portable");
await fs.mkdir(buildRoot, { recursive: true });
const testRoot = await fs.mkdtemp(path.join(buildRoot, "electron-ui-test-"));
const withRefresh = process.argv.includes("--with-refresh");
const execute = promisify(execFile);
const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const env = { ...process.env, PATH: path.join(process.env.SystemRoot, "System32") };
for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH", "XINLE_USERNAME", "XINLE_PASSWORD", "XINLE_BROWSER_PATH", "XINLE_NODE_PATH", "XINLE_DATA_DIR"]) delete env[key];
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
const waitFor = async (check, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Electron 窗口验收等待超时。");
};
let application;
let activeSession;
const ownedPids = new Set();
try {
  application = await _electron.launch({
    executablePath: path.join(root, "build", "electron-release", "win-unpacked", "XinlePriceDashboard.exe"),
    args: ["--data-root", testRoot], env, timeout: 60_000,
  });
  const page = await application.firstWindow();
  await page.locator("#login-config-button").waitFor({ state: "visible" });
  assert.equal(await page.locator("#refresh-button").isVisible(), true);
  assert.match(await page.title(), /每日票价/);
  assert.equal(await page.locator("body").innerText().then((text) => text.includes("Chrome 测试版")), false);
  const windowState = await application.evaluate(({ BrowserWindow, Menu }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const options = window.webContents.getLastWebPreferences();
    return {
      electronVersion: process.versions.electron,
      windowCount: BrowserWindow.getAllWindows().length,
      visible: window.isVisible(), menuRemoved: Menu.getApplicationMenu() === null,
      sandbox: options.sandbox, contextIsolation: options.contextIsolation,
      nodeIntegration: options.nodeIntegration,
    };
  });
  assert.equal(windowState.windowCount, 1);
  assert.equal(windowState.visible, true);
  assert.equal(windowState.menuRemoved, true);
  assert.equal(windowState.sandbox, true);
  assert.equal(windowState.contextIsolation, true);
  assert.equal(windowState.nodeIntegration, false);
  await page.locator("#login-config-button").click();
  await page.locator("#login-config-password").waitFor({ state: "visible" });
  assert.equal(await page.locator("#login-config-password").inputValue(), "");
  await page.locator("#login-config-close").click();
  await page.screenshot({ path: path.join(buildRoot, "electron-window.png"), fullPage: false });
  activeSession = JSON.parse(await fs.readFile(path.join(testRoot, "session.json"), "utf8"));
  ownedPids.add(activeSession.serverPid);

  if (withRefresh) {
    const post = (endpoint, data) => fetch(activeSession.url + endpoint, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: activeSession.url }, body: JSON.stringify(data),
    });
    assert.equal((await post("/api/login-config", readLoginCredentials())).ok, true);
    assert.equal((await post("/api/refresh", {})).ok, true);
    // 关闭窗口时故意保留正在运行的采集，以验证整个自有进程树都会退出。
    await waitFor(async () => {
      const script = `
        $queue = [System.Collections.Generic.Queue[int]]::new()
        $queue.Enqueue(${activeSession.serverPid})
        $result = @()
        while ($queue.Count -gt 0) {
          $parentProcessId = $queue.Dequeue()
          foreach ($childProcess in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentProcessId")) {
            $queue.Enqueue([int]$childProcess.ProcessId)
            $result += [pscustomobject]@{pid=[int]$childProcess.ProcessId; name=$childProcess.Name}
          }
        }
        ConvertTo-Json -InputObject @($result) -Compress
      `;
      const { stdout } = await execute(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
      const descendants = JSON.parse(stdout.trim() || "[]");
      descendants.forEach((child) => ownedPids.add(child.pid));
      return descendants.some((child) => child.name === "chrome.exe");
    });
  }
  const closed = application.waitForEvent("close");
  // Windows 标题栏关闭按钮会触发同一 BrowserWindow.close 路径。
  await application.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 100); });
  await closed;
  await waitFor(() => [...ownedPids].every((pid) => !alive(pid)), 15_000);
  await assert.rejects(fs.access(path.join(testRoot, "session.json")), { code: "ENOENT" });
  const report = { passed: true, ...windowState, closedDuringRefresh: withRefresh, ownedProcessesStopped: ownedPids.size, testRoot, testedAt: new Date().toISOString() };
  await fs.writeFile(path.join(buildRoot, "electron-ui-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  try { await application?.close(); } catch { }
  if (activeSession && alive(activeSession.serverPid)) {
    try { await execute(path.join(process.env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(activeSession.serverPid), "/T", "/F"], { windowsHide: true }); } catch { }
  }
  await fs.rm(path.join(testRoot, "data", "config", "login.json"), { force: true });
}
