import type { Page } from "patchright";
import { readLoginCredentials } from "./login-config.ts";

export interface LoginCredentials {
  username: string;
  password: string;
}

/** 从项目本地配置加载凭据，不在导入模块时启动浏览器或登录。 */
export function loadLoginCredentials(): LoginCredentials {
  const { username, password } = readLoginCredentials();
  if (!username || !password) {
    throw new Error("请先在价格看板的「登录配置」中保存账号和密码。");
  }
  return { username, password };
}

/** Playwright 的操作错误可能包含 fill 参数，记录前需隐藏凭据。 */
export function redactLoginError(
  error: unknown,
  credentials?: LoginCredentials,
): string {
  let message = error instanceof Error ? error.message : String(error);
  const values = [
    credentials?.password ?? process.env.XINLE_PASSWORD,
    credentials?.username ?? process.env.XINLE_USERNAME,
  ];
  for (const value of values) {
    if (value) message = message.split(value).join("[已隐藏]");
  }
  return message;
}

/** 在调用方的 Page 上登录并进入首页，保留同一浏览器会话供后续任务使用。 */
export async function loginToHome(
  page: Page,
  credentials: LoginCredentials = loadLoginCredentials(),
): Promise<void> {
  try {
    console.log("正在打开网站，等待登录表单……");
    try {
      await page.goto("http://xinle.xyj.link", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    } catch (error) {
      // 安全检测可能中断首次导航，随后由页面自行跳转到登录页。
      if (!/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(String(error))) throw error;
    }

    await page.locator("#user_name").waitFor({
      state: "visible",
      timeout: 60_000,
    });
    await page.locator("#user_name").fill(credentials.username);
    await page.locator("#password").fill(credentials.password);
    if (await page.locator("#L_vercode").isVisible()) {
      throw new Error("网站要求验证码，请在保留的浏览器窗口中手动完成登录。");
    }

    console.log("正在提交登录表单……");
    // 每次运行只提交一次，避免登录失败时不断重试。
    await page.getByRole("button", { name: "立即登录", exact: true }).click();
    try {
      await page.waitForURL(
        (url) =>
          url.hostname === "xinle.xyj.link" &&
          !url.pathname.endsWith("/login.html"),
        { waitUntil: "domcontentloaded", timeout: 30_000 },
      );
    } catch {
      throw new Error("登录后未发生预期跳转，请检查浏览器中的登录提示。");
    }

    if (new URL(page.url()).pathname.endsWith("/modifyPasswordPage.html")) {
      console.log("网站显示修改密码提示，接下来按要求重新访问首页。");
    }

    console.log("正在访问 https://xinle.xyj.link ……");
    await page.goto("https://xinle.xyj.link", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    // 验证已登录首页，避免把登录页或安全检测页当作成功。
    await page.locator('a[href="javascript:loginOut();"]').waitFor({
      state: "attached",
      timeout: 30_000,
    });
    await page.getByText("首页", { exact: true }).first().waitFor({
      state: "visible",
      timeout: 30_000,
    });
    console.log(`登录成功，已进入首页：${page.url()}`);
  } catch (error) {
    throw new Error(redactLoginError(error, credentials));
  }
}
