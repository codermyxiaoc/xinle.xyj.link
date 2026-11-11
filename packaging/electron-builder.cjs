const path = require("node:path");
const fs = require("node:fs/promises");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");

module.exports = {
  appId: "link.xyj.xinle.price-dashboard",
  productName: "每日票价",
  executableName: "XinlePriceDashboard",
  directories: {
    app: "desktop",
    output: "build/electron-release",
    buildResources: "packaging/assets",
  },
  files: ["main.cjs", "package.json"],
  extraResources: [
    { from: "build/portable/staging", to: "runtime", filter: ["**/*"] },
    // electron-builder 默认跳过资源目录中的 node_modules，两个运行依赖必须单独复制。
    { from: "build/portable/staging/node_modules/patchright", to: "runtime/node_modules/patchright", filter: ["**/*"] },
    { from: "build/portable/staging/node_modules/patchright-core", to: "runtime/node_modules/patchright-core", filter: ["**/*"] },
  ],
  afterPack: async ({ appOutDir }) => {
    const runtime = path.join(appOutDir, "resources", "runtime");
    for (const file of ["runtime/node.exe", "browser/chrome-win64/chrome.exe", "node_modules/patchright/package.json", "node_modules/patchright-core/package.json", "lib/ticket-type-config.ts"]) {
      await fs.access(path.join(runtime, file));
    }
    for (const file of ["config/login.json", "config/ticket-types.json", ".env.local", "output/ticket-prices.json"]) {
      try { await fs.access(path.join(runtime, file)); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      throw new Error(`分发包不能包含个人配置或数据：${file}`);
    }
    const environment = { ...process.env, PATH: path.join(process.env.SystemRoot, "System32") };
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"]) delete environment[name];
    await promisify(execFile)(path.join(runtime, "runtime", "node.exe"), ["--input-type=module", "-e", "import('patchright').then(({chromium})=>{if(!chromium)process.exit(1)})"], {
      cwd: runtime, env: environment, windowsHide: true, timeout: 30_000,
    });
    console.log("内置采集依赖独立加载成功，已检查发行包不含个人配置。");
  },
  asar: true,
  electronDist: path.resolve(__dirname, "../node_modules/electron/dist"),
  npmRebuild: false,
  compression: "normal",
  win: {
    target: [{ target: "portable", arch: ["x64"] }],
    artifactName: "XinlePriceDashboard-Electron.exe",
    signAndEditExecutable: false,
  },
  portable: {
    requestExecutionLevel: "user",
    // 固定的 electron-builder 26.18.0 中 true 才省略 UNPACK_DIR_NAME，
    // 每次使用独立的 $PLUGINSDIR，避免第二次启动清理正在运行实例的文件。
    unpackDirName: true,
    splashImage: null,
  },
};
