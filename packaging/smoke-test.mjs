import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readLoginCredentials } from "../lib/login-config.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const executable = path.join(root, "dist", "XinlePriceDashboard-Electron.exe");
const withRefresh = process.argv.includes("--with-refresh");
const execFileAsync = promisify(execFile);
const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
await fs.mkdir(path.join(root, "build", "portable"), { recursive: true });
const testRoot = await fs.mkdtemp(path.join(root, "build", "portable", "exe-test-"));
const sessionFile = path.join(testRoot, "session.json");
const env = {
  ...process.env,
  PATH: path.join(process.env.SystemRoot, "System32"),
  DOTNET_ROOT: path.join(testRoot, "no-system-dotnet"),
  DOTNET_ROOT_X64: path.join(testRoot, "no-system-dotnet"),
  DOTNET_MULTILEVEL_LOOKUP: "0",
  DOTNET_BUNDLE_EXTRACT_BASE_DIR: path.join(testRoot, ".net"),
};
for (const name of ["NODE_OPTIONS", "NODE_PATH", "XINLE_USERNAME", "XINLE_PASSWORD", "XINLE_DATA_DIR", "XINLE_BROWSER_PATH", "XINLE_NODE_PATH", "ELECTRON_RUN_AS_NODE"]) delete env[name];
let launcher;
let session;
const waitFor = async (condition, timeout = 180_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await condition();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("便携版验收等待超时。");
};
const start = () => spawn(executable, ["--data-root", testRoot, "--no-window"], { cwd: testRoot, env, windowsHide: true, stdio: "ignore" });
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
const readSession = async (child) => waitFor(async () => {
  if (child.exitCode !== null) throw new Error(`EXE 意外退出，退出码 ${child.exitCode}；查看 ${testRoot} 内启动日志。`);
  try {
    const current = JSON.parse(await fs.readFile(sessionFile, "utf8"));
    // Portable EXE 是解压包装器；真正的 Electron 主进程 PID 与包装器不同。
    assert.equal(path.resolve(current.dataDirectory), path.join(testRoot, "data"));
    assert.match(current.electronVersion, /^\d+\.\d+\.\d+/);
    assert.match(current.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    return alive(current.launcherPid) && alive(current.serverPid) ? current : null;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
});
const verifyRuntime = async () => {
  const nodePath = path.join(session.runtimeDirectory, "runtime", "node.exe");
  const browserPath = path.join(session.runtimeDirectory, "browser", "chrome-win64", "chrome.exe");
  await fs.access(nodePath);
  await fs.access(browserPath);
  await fs.access(path.join(session.runtimeDirectory, "tests", "collect-ticket-prices.ts"));
  await fs.access(path.join(session.runtimeDirectory, "node_modules", "patchright", "package.json"));
  await fs.access(path.join(session.runtimeDirectory, "node_modules", "patchright-core", "package.json"));
  await assert.rejects(fs.access(path.join(session.runtimeDirectory, "config", "login.json")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(session.runtimeDirectory, "config", "ticket-types.json")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(session.runtimeDirectory, ".env.local")), { code: "ENOENT" });
  const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process -Id ${session.serverPid} -ErrorAction Stop).Path`], { windowsHide: true });
  assert.equal(path.resolve(stdout.trim()).toLowerCase(), path.resolve(nodePath).toLowerCase());
};

// 仅查询本次价格服务的子孙进程，不输出其他程序的命令行、路径或账号信息。
const sampleCollectorWindows = async () => {
  const script = `
    $ErrorActionPreference = 'Stop'
    $pendingParents = [System.Collections.Generic.Queue[int]]::new()
    $pendingParents.Enqueue(${session.serverPid})
    $observations = @()
    while ($pendingParents.Count -gt 0) {
      $parentProcessId = $pendingParents.Dequeue()
      foreach ($childProcess in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentProcessId")) {
        $pendingParents.Enqueue([int]$childProcess.ProcessId)
        if ($childProcess.Name -ne 'chrome.exe') { continue }
        $runningProcess = Get-Process -Id $childProcess.ProcessId -ErrorAction SilentlyContinue
        if ($null -eq $runningProcess) { continue }
        $observations += [pscustomobject]@{
          pid = [int]$childProcess.ProcessId
          headless = [bool]($childProcess.CommandLine -match '(?:^|\\s)--headless(?:[=\\s]|$)')
          direct = [bool]($childProcess.CommandLine -match '(?:^|\\s)--no-proxy-server(?:\\s|$)')
          hasWindow = [bool]($runningProcess.MainWindowHandle -ne [IntPtr]::Zero)
        }
      }
    }
    ConvertTo-Json -InputObject @($observations) -Compress
  `;
  const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024,
  });
  return JSON.parse(stdout.trim() || "[]");
};
const get = async (endpoint) => {
  const response = await fetch(session.url + endpoint);
  return { status: response.status, data: await response.json() };
};
const post = async (endpoint, data) => {
  const response = await fetch(session.url + endpoint, { method: "POST", headers: { "Content-Type": "application/json", Origin: session.url }, body: JSON.stringify(data) });
  assert.equal(response.status < 300, true, `API ${endpoint} 状态 ${response.status}`);
  return response.json();
};
const stop = async () => {
  if (session) {
    try { process.kill(session.serverPid); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  if (launcher) await waitFor(() => launcher.exitCode !== null, 15_000);
  if (session) await waitFor(() => !alive(session.launcherPid) && !alive(session.serverPid), 15_000);
  await assert.rejects(fs.access(sessionFile), { code: "ENOENT" });
};

try {
  console.log("启动全新隔离 Electron EXE：不使用系统 Node、Edge 或 .NET 安装路径。");
  launcher = start();
  session = await readSession(launcher);
  await verifyRuntime();
  assert.equal((await fetch(session.url)).status, 200);
  assert.deepEqual((await get("/api/login-config")).data, { username: "", hasPassword: false });
  assert.equal((await get("/api/prices")).status, 404);
  assert.equal(path.resolve(session.dataDirectory), path.join(testRoot, "data"));
  const second = start();
  await waitFor(() => second.exitCode !== null, 90_000);
  assert.equal(second.exitCode, 0);
  assert.equal(JSON.parse(await fs.readFile(sessionFile, "utf8")).serverPid, session.serverPid);
  await verifyRuntime();
  console.log("独立运行、首次空账号、空数据、单实例检查通过。");

  const credentials = withRefresh ? readLoginCredentials() : { username: "portable-smoke-test", password: "local-test-only" };
  const saved = await post("/api/login-config", credentials);
  assert.equal(saved.hasPassword, true);
  assert.equal("password" in saved, false);
  const config = JSON.parse(await fs.readFile(path.join(session.dataDirectory, "config", "login.json"), "utf8"));
  assert.equal(config.username, credentials.username);
  assert.equal(config.password, credentials.password);
  let priceCount = null;
  let headlessVerified = false;
  let directVerified = false;
  let localTicketTypeVerified = false;
  let overriddenPrices = null;
  const observedBrowserPids = new Set();
  if (withRefresh) {
    await post("/api/refresh", {});
    const result = await waitFor(async () => {
      for (const observation of await sampleCollectorWindows()) {
        observedBrowserPids.add(observation.pid);
        assert.equal(observation.hasWindow, false, "价格采集不得出现可见浏览器窗口。");
        if (observation.headless) {
          headlessVerified = true;
          directVerified ||= observation.direct;
        }
      }
      const status = (await get("/api/refresh")).data;
      if (status.status === "error") throw new Error(status.error);
      return status.status === "success" ? status : null;
    }, 240_000);
    const prices = (await get("/api/prices")).data;
    assert.equal(prices.collectionStatus, "complete");
    assert.equal(result.progress.current, prices.summary.productCount);
    assert.equal(headlessVerified, true, "未观察到 --headless 的采集浏览器主进程。");
    assert.equal(directVerified, true, "采集浏览器必须保持 --no-proxy-server 直连。");
    await waitFor(() => [...observedBrowserPids].every((pid) => !alive(pid)), 15_000);
    priceCount = prices.summary.priceCount;
    console.log(`EXE 无头直连采集成功：${prices.summary.productCount} 个渠道，${priceCount} 条日价；采集期间无浏览器窗口。`);
    if (prices.products?.["1036"]) {
      assert.equal(prices.products["1036"].sourceTicketType ?? prices.products["1036"].ticketType, "CHILDREN");
      const settings = await post("/api/ticket-types", { overrides: { "1036": "adult" } });
      assert.equal(settings.overrides["1036"], "adult");
      overriddenPrices = (await get("/api/prices")).data;
      const exported = (await get("/api/download")).data;
      const persisted = JSON.parse(await fs.readFile(path.join(session.dataDirectory, "output", "ticket-prices.json"), "utf8"));
      for (const snapshot of [overriddenPrices, exported, persisted]) {
        assert.equal(snapshot.products["1036"].group, "adult");
        assert.equal(snapshot.products["1036"].ticketType, "ADULT");
        assert.equal(snapshot.products["1036"].sourceTicketType, "CHILDREN");
        assert.equal(snapshot.products["1036"].ticketTypeSource, "local");
        assert.equal(snapshot.summary.priceCount, priceCount);
        assert.deepEqual(snapshot.prices.adult["1036"], prices.prices.children["1036"]);
        assert.equal("1036" in snapshot.prices.children, false);
      }
      localTicketTypeVerified = true;
      console.log("1036 本地成人票覆盖已同步到看板、JSON 下载与持久化文件，日价数量及金额保持一致。");
    }
  }
  await stop();
  launcher = start();
  session = await readSession(launcher);
  await verifyRuntime();
  assert.deepEqual((await get("/api/login-config")).data, { username: credentials.username, hasPassword: true });
  if (withRefresh) assert.equal((await get("/api/prices")).data.summary.priceCount, priceCount);
  if (localTicketTypeVerified) {
    assert.equal((await get("/api/ticket-types")).data.overrides["1036"], "adult");
    assert.equal((await get("/api/prices")).data.products["1036"].group, "adult");
    const restored = await post("/api/ticket-types", { overrides: { "1036": null } });
    assert.equal("1036" in restored.overrides, false);
    const resetPrices = (await get("/api/prices")).data;
    assert.equal(resetPrices.products["1036"].group, "children");
    assert.equal(resetPrices.products["1036"].ticketType, "CHILDREN");
    assert.equal(resetPrices.products["1036"].ticketTypeSource, "remote");
    assert.equal(resetPrices.summary.priceCount, priceCount);
    assert.deepEqual(resetPrices.prices.children["1036"], overriddenPrices.prices.adult["1036"]);
  }
  await stop();
  const report = { passed: true, electronVersion: session.electronVersion, firstRunClean: true, bundledRuntimeVerified: true, singleInstance: true, persistenceAfterRestart: true, shutdownCleanup: true, withRefresh, headlessVerified, directVerified, localTicketTypeVerified, observedBrowserProcesses: observedBrowserPids.size, priceCount, testRoot, testedAt: new Date().toISOString() };
  await fs.writeFile(path.join(root, "build", "portable", "smoke-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  try { if (session) process.kill(session.serverPid); } catch { }
  try {
    if (session && alive(session.launcherPid)) {
      await execFileAsync(path.join(process.env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(session.launcherPid), "/T", "/F"], { windowsHide: true });
    }
  } catch { }
  try { if (launcher && launcher.exitCode === null) launcher.kill(); } catch { }
  // 验收凭据绝不保留到构建目录或分发包。
  await fs.rm(path.join(testRoot, "data", "config", "login.json"), { force: true });
  await fs.rm(path.join(testRoot, "data", "config", "ticket-types.json"), { force: true });
}
