import type { Browser, Page } from "patchright";
import { launchBrowser } from "../tools.ts";
import { loginToHome, redactLoginError } from "../lib/login.ts";
import { buildPriceExport, normalizeProduct } from "../lib/ticket-prices.ts";
import type { NormalizedProduct } from "../lib/ticket-prices.ts";
import { persistPriceExport } from "../lib/price-store.ts";
import { resolveRuntimePaths } from "../lib/runtime-paths.ts";
import { applyTicketTypeOverrides, readTicketTypeOverrides } from "../lib/ticket-type-config.ts";

const origin = "https://xinle.xyj.link";
const outputDir = resolveRuntimePaths().outputDir;
const visible = process.argv.includes("--visible") && !process.argv.includes("--background");
const keepOpen = visible && process.argv.includes("--keep-open");
const cancellation = new AbortController();
let browser: Browser | undefined;
let browserClosing: Promise<void> | undefined;
const closeBrowser = () => {
  if (!browser) return Promise.resolve();
  return browserClosing ??= browser.close();
};
const parentDisconnected = () => {
  cancellation.abort(new Error("价格服务已退出，采集已取消。"));
  // 若仍在 launch，主流程拿到浏览器后会立刻检测取消并在 finally 中关闭。
  if (browser) void closeBrowser().catch(() => {});
};
// send 在启动即断开 IPC 后仍存在，而 channel 可能已经被 Node 清空。
if (typeof process.send === "function") {
  process.once("disconnect", parentDisconnected);
  if (!process.connected) parentDisconnected();
}

// 请求在已登录的 Edge 页面内发出，复用 Cookie 和项目的浏览器网络配置。
async function readApi(page: Page, endpoint: string, form?: Record<string, string>) {
  return page.evaluate(async ({ endpoint, form }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(endpoint, {
        method: form ? "POST" : "GET",
        credentials: "same-origin",
        headers: form ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {},
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`价格查询 HTTP ${response.status}：${endpoint}`);
      const data = await response.json();
      if (Number(data.code) !== 1) {
        throw new Error(`查询失败：${String(data.msg ?? "未返回成功状态")}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }, { endpoint, form });
}

function readListPage(response: any, expectedPage: number) {
  if (Number(response?.code) !== 1 || !Array.isArray(response?.obj?.data)) {
    throw new Error(`第 ${expectedPage} 页产品列表格式错误。`);
  }
  const current = Number(response.obj.current_page);
  const last = Number(response.obj.last_page);
  if (current !== expectedPage || !Number.isSafeInteger(last) || last < current) {
    throw new Error(`产品分页信息异常：期望 ${expectedPage}，收到 ${current}/${last}。`);
  }
  return { spots: response.obj.data as any[], last };
}

try {
  cancellation.signal.throwIfAborted();
  const launched = await launchBrowser(visible, { headless: !visible });
  browser = launched.browser;
  const page = launched.page;
  cancellation.signal.throwIfAborted();
  await loginToHome(page);
  cancellation.signal.throwIfAborted();
  await page.goto(`${origin}/scm/spot/search.html?showDetail=1`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  const [first] = await Promise.all([page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/scm/spot/getSearchData.html" &&
      url.searchParams.get("key_word") === "特权" &&
      url.searchParams.get("page") === "1";
  }, { timeout: 60_000 }), page.getByText("我的特权产品", { exact: true }).click()]);
  cancellation.signal.throwIfAborted();
  if (!first.ok()) throw new Error(`特权产品查询 HTTP ${first.status()}。`);
  const sourceUrl = first.url();
  let listPage = readListPage(await first.json(), 1);
  const allSpots: any[] = [...listPage.spots];
  const pagination = [{ page: 1, spotCount: listPage.spots.length }];

  for (let number = 2; number <= listPage.last; number++) {
    cancellation.signal.throwIfAborted();
    const url = new URL(sourceUrl);
    url.searchParams.set("page", String(number));
    listPage = readListPage(await readApi(page, url.pathname + url.search), number);
    allSpots.push(...listPage.spots);
    pagination.push({ page: number, spotCount: listPage.spots.length });
  }

  const productsById = new Map<number, NormalizedProduct>();
  for (const spot of allSpots) {
    if (!Array.isArray(spot.goodsList)) throw new Error(`景区 ${spot.spot_id} 缺少 goodsList。`);
    for (const raw of spot.goodsList) {
      const product = normalizeProduct(raw, spot);
      const previous = productsById.get(product.goodsId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(product)) {
        throw new Error(`商品 ${product.goodsId} 在列表中出现不一致的元数据。`);
      }
      productsById.set(product.goodsId, product);
    }
  }
  const products = [...productsById.values()].sort((a, b) => a.goodsId - b.goodsId);
  console.log(`已读取 ${pagination.length} 页特权产品，共 ${products.length} 个票种。`);

  const recordsByGoods: Record<string, unknown[]> = {};
  const failures: { goodsId: number; message: string }[] = [];
  for (const [index, product] of products.entries()) {
    cancellation.signal.throwIfAborted();
    try {
      // 与每个“预订”页面日历发出的请求一致，不限定月份，取接口全部开放日期。
      const data = await readApi(page, "/scm/goods/getGoodsPrice", {
        goods_id: String(product.goodsId),
        product_scan_goods_id: "",
        scanCode: "",
      });
      if (!Array.isArray(data.obj)) throw new Error("价格接口 obj 不是数组。");
      recordsByGoods[String(product.goodsId)] = data.obj;
      console.log(`[${index + 1}/${products.length}] ${product.goodsId} ${product.ticketType}：${data.obj.length} 个日期`);
    } catch (error) {
      cancellation.signal.throwIfAborted();
      const message = redactLoginError(error);
      failures.push({ goodsId: product.goodsId, message });
      console.error(`[${product.goodsId}] ${message}`);
    }
  }

  const result = {
    ...buildPriceExport(products, recordsByGoods, { sourceUrl }),
    collectionStatus: failures.length ? "partial" : "complete",
    collection: {
      pagination,
      requestedProducts: products.length,
      completedProducts: Object.keys(recordsByGoods).length,
      priceEndpoint: `${origin}/scm/goods/getGoodsPrice`,
      priceMethod: "POST",
      dateScope: "接口当前返回的全部开放日期；请求未限定月份或日期范围。",
      failures,
    },
  };
  // 仅发布完整快照；失败时拒绝覆盖上次成功的数据。
  cancellation.signal.throwIfAborted();
  const effective = applyTicketTypeOverrides(result, readTicketTypeOverrides());
  await persistPriceExport(effective, outputDir, { signal: cancellation.signal });
  console.log("采集统计：" + JSON.stringify(effective.summary));
  for (const warning of effective.warnings) console.warn("数据提示：" + warning);
  console.log(`已导出：${outputDir}`);
} catch (error) {
  process.exitCode = 1;
  console.error("采集未完成：" + redactLoginError(error));
} finally {
  if (keepOpen && !cancellation.signal.aborted && browser?.isConnected()) {
    console.log("浏览器窗口已保留，关闭窗口即可结束脚本。");
    await new Promise<void>((resolve) => browser.once("disconnected", resolve));
  } else {
    await closeBrowser();
  }
  process.off("disconnect", parentDisconnected);
  if (process.connected) process.disconnect();
}
