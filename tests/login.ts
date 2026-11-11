import { launchBrowser } from "../tools.ts";
import {
  loadLoginCredentials,
  loginToHome,
  redactLoginError,
} from "../lib/login.ts";

const credentials = loadLoginCredentials();
const { browser, page } = await launchBrowser(true);
const closeAfter = process.argv.includes("--close");

try {
  await loginToHome(page, credentials);
} catch (error) {
  process.exitCode = 1;
  console.error(`自动登录未完成：${redactLoginError(error, credentials)}`);
} finally {
  if (closeAfter) {
    await browser.close();
  } else if (browser.isConnected()) {
    console.log("浏览器窗口已保留，关闭窗口即可结束脚本。");
    await new Promise<void>((resolve) => browser.once("disconnected", resolve));
  }
}
