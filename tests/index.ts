import { launchBrowser } from "../tools.ts";

let { browser, context, page } = await launchBrowser(true);

await page.goto("http://xinle.xyj.link", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
