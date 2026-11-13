import http from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getLoginConfigMetadata, saveLoginConfig } from "./lib/login-config.ts";
import { resolveRuntimePaths } from "./lib/runtime-paths.ts";
import { applyTicketTypeOverrides, readTicketTypeOverrides, saveTicketTypeOverrides } from "./lib/ticket-type-config.ts";
import { persistPriceExport } from "./lib/price-store.ts";
import { buildPriceWorkbook } from "./lib/price-excel.ts";

const projectDir = fileURLToPath(new URL("./", import.meta.url));
type Progress = { current: number; total: number };
type RefreshState = {
  status: "idle" | "running" | "success" | "error";
  startedAt: string | null;
  finishedAt: string | null;
  message: string;
  progress: Progress;
  error: string | null;
};
type Runner = (report: (message: string, progress?: Progress) => void) => Promise<void>;

function collectLatest(report: Parameters<Runner>[0]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["tests/collect-ticket-prices.ts", "--background"], {
      cwd: projectDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      shell: false,
    });
    let pending = "";
    let failure = "";
    let timedOut = false;
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      // 先断开 IPC，让采集脚本关闭浏览器并清理临时文件。
      if (child.connected) child.disconnect();
      else child.kill();
      forceStop = setTimeout(() => child.kill(), 10_000);
      forceStop.unref();
    }, 6 * 60_000);
    const line = (value: string) => {
      const progress = value.match(/^\[(\d+)\/(\d+)\]\s+(\d+)\s+\w+：/);
      const total = value.match(/共 (\d+) 个票种/);
      if (progress) {
        report(`已更新 ${progress[1]} / ${progress[2]} 个渠道`, {
          current: Number(progress[1]), total: Number(progress[2]),
        });
      } else if (total) {
        report(`正在读取 ${total[1]} 个渠道的每日价格`, { current: 0, total: Number(total[1]) });
      } else if (value.includes("登录成功")) report("登录完成，正在读取特权产品");
      else if (value.includes("正在提交登录") || value.includes("等待登录表单")) report("正在登录并连接价格来源");
      else if (value.includes("已导出")) report("已保存最新价格，正在完成更新");
      if (value.startsWith("采集未完成：")) failure = value.slice("采集未完成：".length).split("\n")[0];
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      lines.forEach(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => chunk.split(/\r?\n/).forEach(line));
    child.once("error", (error) => { clearTimeout(timer); clearTimeout(forceStop); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(forceStop);
      if (pending) line(pending);
      if (timedOut) reject(new Error("采集超时，已保留上一次成功的数据。请稍后重试。"));
      else if (code !== 0) reject(new Error(failure || "采集没有完整完成，已保留上一次成功的数据。"));
      else resolve();
    });
  });
}

export function createDashboardServer(options: {
  outputDir?: string;
  webDir?: string;
  configRoot?: string;
  runRefresh?: Runner;
} = {}) {
  const runtimePaths = resolveRuntimePaths();
  const outputDir = options.outputDir ?? runtimePaths.outputDir;
  const webDir = options.webDir ?? path.join(projectDir, "web");
  const configRoot = options.configRoot ?? runtimePaths.dataRoot;
  const runner = options.runRefresh ?? collectLatest;
  let refresh: RefreshState = {
    status: "idle", startedAt: null, finishedAt: null,
    message: "等待手动刷新", progress: { current: 0, total: 0 }, error: null,
  };

  const readSnapshot = async () => {
    const result = JSON.parse(await readFile(path.join(outputDir, "ticket-prices.json"), "utf8"));
    if (result.collectionStatus !== "complete" || !result.prices || !result.products || !Array.isArray(result.rows)) {
      throw new Error("当前文件不是完整的价格数据，请重新刷新。");
    }
    return result;
  };
  const snapshot = async () => applyTicketTypeOverrides(await readSnapshot(), readTicketTypeOverrides(configRoot));
  // 本地票种发布串行化；采集期间仅保存设置和即时重分类读取结果，避免覆盖正在写入的新价格。
  let publication = Promise.resolve();
  const serializePublication = <T,>(operation: () => Promise<T>): Promise<T> => {
    const next = publication.then(operation);
    publication = next.then(() => {}, () => {});
    return next;
  };
  const synchronizeTicketTypes = async () => {
    const original = await readSnapshot();
    const overrides = readTicketTypeOverrides(configRoot);
    const effective = applyTicketTypeOverrides(original, overrides);
    const hasLocalTypes = Object.keys(overrides).length > 0 ||
      Object.values(original.products).some((product: any) => product.ticketTypeSource === "local");
    const needsSchemaUpgrade = original.schemaVersion !== effective.schemaVersion;
    if ((hasLocalTypes || needsSchemaUpgrade) && JSON.stringify(original) !== JSON.stringify(effective)) {
      await persistPriceExport(effective, outputDir);
    }
    return effective;
  };
  const ticketTypeSettings = async () => {
    const overrides = readTicketTypeOverrides(configRoot);
    let data;
    try { data = applyTicketTypeOverrides(await readSnapshot(), overrides); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    const products = Object.values(data?.products ?? {}).map((product: any) => ({
      goodsId: product.goodsId, name: product.name,
      sourceTicketType: product.sourceTicketType ?? product.ticketType,
      sourceGroup: product.sourceGroup ?? product.group,
      spotId: product.spotId ?? null, spotName: product.spotName ?? "",
      destinationKey: product.destinationKey, destinationName: product.destinationName,
      visitDays: product.visitDays ?? null,
      classificationReason: product.classificationReason ?? null,
      group: product.group, override: overrides[String(product.goodsId)] ?? null,
    })).sort((a, b) => a.goodsId - b.goodsId);
    return { overrides, products };
  };
  const startRefresh = () => {
    if (refresh.status === "running") return;
    refresh = {
      status: "running", startedAt: new Date().toISOString(), finishedAt: null,
      message: "正在准备刷新价格", progress: { current: 0, total: 0 }, error: null,
    };
    void (async () => {
      try {
        let previousTime: string | undefined;
        await serializePublication(async () => {
          try { previousTime = (await readSnapshot()).fetchedAt; } catch { /* 首次运行允许没有快照。 */ }
        });
        await runner((message, progress) => {
          refresh = { ...refresh, message, progress: progress ?? refresh.progress };
        });
        await serializePublication(async () => {
          const latest = await synchronizeTicketTypes();
          if (!latest.fetchedAt || latest.fetchedAt === previousTime) {
            throw new Error("采集结束但未发现新的完整数据，旧数据仍保留。请重试。");
          }
          refresh = {
            ...refresh, status: "success", finishedAt: new Date().toISOString(),
            message: "最新价格已更新并保存", error: null,
            progress: { current: latest.summary.productCount, total: latest.summary.productCount },
          };
        });
      } catch (error) {
        refresh = {
          ...refresh, status: "error", finishedAt: new Date().toISOString(),
          message: "刷新失败，继续显示上一次成功的数据",
          error: error instanceof Error ? error.message : "采集失败，请稍后重试。",
        };
        // 失败时旧报价也继续采用刷新期间保存的本地票种。
        await serializePublication(async () => {
          if (refresh.status === "running") return;
          try { await synchronizeTicketTypes(); } catch { /* GET 仍会即时按本地票种显示。 */ }
        });
      }
    })();
  };

  return http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    try {
      const host = req.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(403, { error: "仅允许本机访问。" });
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.method === "GET" && url.pathname === "/api/refresh") return json(200, refresh);
      if (req.method === "GET" && url.pathname === "/api/login-config") {
        try { return json(200, getLoginConfigMetadata(configRoot)); }
        catch { return json(500, { error: "登录配置读取失败，请检查本地配置后重试。" }); }
      }
      if (req.method === "GET" && url.pathname === "/api/ticket-types") {
        try { return json(200, await ticketTypeSettings()); }
        catch { return json(500, { error: "票种设置读取失败，请稍后重试。" }); }
      }
      if (req.method === "POST" && ["/api/refresh", "/api/login-config", "/api/ticket-types"].includes(url.pathname)) {
        if ((req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site") {
          return json(403, { error: "请从本地价格页面操作。" });
        }
        if (!req.headers["content-type"]?.startsWith("application/json")) {
          return json(415, { error: "请求必须使用 JSON。" });
        }
        let body = "";
        for await (const chunk of req) {
          body += chunk.toString();
          if (body.length > (url.pathname === "/api/ticket-types" ? 65536 : 8192)) return json(413, { error: "请求过大。" });
        }
        let input: unknown;
        try { input = JSON.parse(body || "{}"); } catch { return json(400, { error: "请求格式错误。" }); }
        if (url.pathname === "/api/login-config") {
          try {
            const metadata = await saveLoginConfig(input, configRoot);
            return json(200, { ...metadata, message: "登录配置已保存，新配置从下一次刷新开始生效。" });
          } catch (error: any) {
            return json(error.code ? 500 : 400, { error: error.code ? "登录配置保存失败，请稍后重试。" : error.message });
          }
        }
        if (url.pathname === "/api/ticket-types") {
          try { await saveTicketTypeOverrides(input, configRoot); }
          catch (error: any) {
            return json(error.code ? 500 : 400, { error: error.code ? "票种设置保存失败，请稍后重试。" : error.message });
          }
          try {
            await serializePublication(async () => {
              if (refresh.status === "running") return;
              try { await synchronizeTicketTypes(); }
              catch (error: any) { if (error.code !== "ENOENT") throw error; }
            });
            return json(200, { ...await ticketTypeSettings(), message: "票种设置已保存，本地设置优先于接口，后续刷新继续生效。" });
          } catch {
            return json(500, { error: "票种设置已保存，但当前价格文件更新失败。请重新读取或刷新价格。" });
          }
        }
        startRefresh();
        return json(202, refresh);
      }
      if (req.method === "GET" && (url.pathname === "/api/prices" || url.pathname === "/api/download")) {
        try {
          const data = await snapshot();
          if (url.pathname === "/api/download") res.setHeader("Content-Disposition", 'attachment; filename="ticket-prices.json"');
          return json(200, data);
        } catch (error: any) {
          return json(error.code === "ENOENT" ? 404 : 500, {
            error: error.code === "ENOENT" ? "还没有价格数据，请点击手动刷新。" : "价格文件读取失败，请尝试刷新。",
          });
        }
      }
      if (req.method === "GET" && url.pathname === "/api/export.xlsx") {
        try {
          // 与看板共用读取路径，按渠道 ID 应用最新本地票种后再导出。
          const data = await snapshot();
          const workbook = buildPriceWorkbook(data);
          const date = data.fetchedAt.slice(0, 10);
          const filename = `渠道每日最低价-${date}.xlsx`;
          res.writeHead(200, {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="ticket-prices-${date}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
            "Content-Length": workbook.length,
          });
          return res.end(workbook);
        } catch (error: any) {
          return json(error.code === "ENOENT" ? 404 : 500, {
            error: error.code === "ENOENT" ? "还没有价格数据，请先手动刷新后再导出。" : "Excel 导出失败，请检查价格数据或刷新后重试。",
          });
        }
      }
      const staticFiles: Record<string, [string, string]> = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/index.html": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/styles.css": ["styles.css", "text/css; charset=utf-8"],
        "/account.js": ["account.js", "text/javascript; charset=utf-8"],
        "/account.css": ["account.css", "text/css; charset=utf-8"],
        "/ticket-types.js": ["ticket-types.js", "text/javascript; charset=utf-8"],
        "/ticket-types.css": ["ticket-types.css", "text/css; charset=utf-8"],
      };
      if (req.method === "GET" && staticFiles[url.pathname]) {
        const [file, contentType] = staticFiles[url.pathname];
        const body = await readFile(path.join(webDir, file));
        res.writeHead(200, { "Content-Type": contentType });
        return res.end(body);
      }
      json(404, { error: "未找到页面。" });
    } catch {
      if (!res.headersSent) json(500, { error: "服务暂时不可用，请稍后再试。" });
      else res.end();
    }
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  // Electron 意外退出时 IPC 随之断开；退出服务会继续通知正在采集的子进程清理浏览器。
  // 直接使用 node server.ts 的开发模式没有 IPC，不改变其生命周期。
  if (typeof process.send === "function") {
    process.once("disconnect", () => process.exit(0));
    if (!process.connected) process.exit(0);
  }
  const port = Number(process.env.PORT ?? 3186);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT 必须是 0～65535 的整数（0 表示自动选择空闲端口）。");
  const server = createDashboardServer();
  server.on("error", (error: any) => {
    console.error(error.code === "EADDRINUSE" ? `端口 ${port} 已被占用，请通过 PORT 指定其他端口。` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actualPort = address && typeof address !== "string" ? address.port : port;
    console.log(`价格看板已启动：http://127.0.0.1:${actualPort}`);
  });
}
