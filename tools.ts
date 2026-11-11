import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from "patchright";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrowserLaunchOptions } from "./lib/runtime-paths.ts";

/** 注入脚本目录：prevent.js（chrome.app/csi/loadTimes 等全套 evasions） */
const SCRIPT_DIR = fileURLToPath(new URL("./script/", import.meta.url));
const INJECT_SCRIPTS = ["prevent.js"].map((f) => path.join(SCRIPT_DIR, f));

/** 启动浏览器 + 全局注入 prevent.js；返回可重建的句柄（供 intro.ts 等工具复用） */
export async function launchBrowser(
  visible = false,
  options: { headless?: boolean } = {},
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  // 旧调用保留屏幕外有头模式；价格采集显式使用无头模式，不创建浏览器窗口。
  const headless = options.headless ?? false;
  const browser = await chromium.launch({
    headless,
    ...resolveBrowserLaunchOptions(),
    args: [
      "--no-proxy-server",
      ...(headless || visible ? [] : ["--window-position=-32000,-32000"]),
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    colorScheme: "light",
  });
  for (const inj of INJECT_SCRIPTS) {
    await context.addInitScript(fs.readFileSync(inj, "utf-8"));
  }
  const page = await context.newPage();
  return { browser, context, page };
}
