import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const buildRoot = path.resolve(root, "build", "portable");
const staging = path.join(buildRoot, "staging");
const require = createRequire(path.join(root, "package.json"));
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("请在 Windows x64 上制作此发行版。");
const patchrightDir = path.dirname(require.resolve("patchright/package.json"));
const packageRequire = createRequire(path.join(patchrightDir, "package.json"));
const coreDir = path.dirname(packageRequire.resolve("patchright-core/package.json"));
const { chromium } = require("patchright");
const browserExe = chromium.executablePath();
await fs.access(browserExe);
const browserDir = path.dirname(browserExe);

// 只清理固定的构建暂存目录，拒绝符号链接，绝不触及工作区配置或价格数据。
if (path.dirname(staging) !== buildRoot || !buildRoot.startsWith(path.resolve(root) + path.sep)) {
  throw new Error("构建目录不在项目内部。");
}
try {
  const stat = await fs.lstat(staging);
  if (stat.isSymbolicLink()) throw new Error("构建暂存目录不能是符号链接。");
  await fs.rm(staging, { recursive: true, force: true });
} catch (error) { if (error.code !== "ENOENT") throw error; }
await fs.mkdir(staging, { recursive: true });

const copy = async (source, target) => {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, dereference: true });
};
for (const filename of ["server.ts", "tools.ts"]) await copy(path.join(root, filename), path.join(staging, filename));
for (const directory of ["lib", "web", "script"]) await copy(path.join(root, directory), path.join(staging, directory));
for (const filename of ["collect-ticket-prices.ts", "login.ts"]) await copy(path.join(root, "tests", filename), path.join(staging, "tests", filename));
await copy(patchrightDir, path.join(staging, "node_modules", "patchright"));
await copy(coreDir, path.join(staging, "node_modules", "patchright-core"));
await copy(process.execPath, path.join(staging, "runtime", "node.exe"));
await copy(browserDir, path.join(staging, "browser", "chrome-win64"));
await copy(path.join(path.dirname(process.execPath), "LICENSE"), path.join(staging, "licenses", "NODE-LICENSE.txt"));
const patchrightPackage = JSON.parse(await fs.readFile(path.join(patchrightDir, "package.json"), "utf8"));
const browserManifest = JSON.parse(await fs.readFile(path.join(coreDir, "browsers.json"), "utf8"));
const browser = browserManifest.browsers.find((item) => item.name === "chromium");
await fs.writeFile(path.join(staging, "package.json"), JSON.stringify({
  name: "xinle-price-dashboard-runtime", version: "1.3.0", private: true, type: "module",
  dependencies: { patchright: patchrightPackage.version },
}, null, 2));
await fs.writeFile(path.join(staging, "build-manifest.json"), JSON.stringify({
  version: "1.3.0", platform: "win-x64", desktop: "electron", collectionMode: "headless", builtAt: new Date().toISOString(),
  node: process.version, patchright: patchrightPackage.version,
  chromium: browser.browserVersion, chromiumRevision: browser.revision,
  containsCredentials: false, containsUserData: false,
}, null, 2));

let count = 0;
let bytes = 0;
async function audit(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const relative = path.relative(staging, filename).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) throw new Error(`分发包包含外部链接：${relative}`);
    if (relative === ".env.local" || relative.startsWith("config/") || relative.startsWith("output/")) {
      throw new Error(`禁止将账号或个人数据加入分发包：${relative}`);
    }
    if (entry.isDirectory()) await audit(filename);
    else { count++; bytes += (await fs.stat(filename)).size; }
  }
}
await audit(staging);
console.log(`便携文件已准备：${count} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MiB。`);
console.log(`运行时：Node ${process.version} / Patchright ${patchrightPackage.version} / Chromium ${browser.browserVersion}`);
console.log("已排除账号密码、历史价格、日志和开发缓存。");
