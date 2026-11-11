# Windows 单文件发行版

`dist/XinlePriceDashboard-Electron.exe` 面向 Windows 10 / 11 64 位。它包含 Electron 桌面窗口、项目页面、Node.js、Patchright 和采集用 Chromium，目标电脑不需要安装开发环境或浏览器。界面由 Electron 显示，不出现 Chrome 测试版横幅。

## 使用

1. 关闭旧版看板，把 `XinlePriceDashboard-Electron.exe` 复制到目标电脑并双击。
2. 启动时会解压内置环境，然后打开独立的 Electron 看板窗口。
3. 点击「登录配置」，保存该电脑需要使用的账号密码。
4. 点击「手动刷新价格」采集并保存最新数据；采集全程无头运行，不弹出浏览器，仍使用直连访问票务网站。
5. 在「票种设置」中可按渠道指定成人票或儿童票，保存后本地设置始终优先；选择「跟随接口」可恢复来源分类。
6. 关闭看板窗口会退出本次启动的后台服务和正在运行的采集。

发行包不包含开发电脑上的账号、密码、历史价格或浏览器登录状态。

## 数据目录

默认保存在当前 Windows 用户的 `%LOCALAPPDATA%\XinlePriceDashboard`：

- `data\config\login.json`：用户在页面保存的登录配置。
- `data\config\ticket-types.json`：按渠道编号保存的本地票种设置，后续刷新不会覆盖。
- `data\output\ticket-prices.json`：最近一次成功的完整价格数据。
- `data\output\ticket-prices.previous.json`：上一次成功数据的备份。
- `electron-profile`：Electron 窗口的独立缓存目录。
- `launcher.log`：桌面启动日志，不记录账号密码。

账号及价格数据和 EXE 文件的位置分离，更新或移动 EXE 不会覆盖已有配置。与上一版 EXE 使用相同的数据目录，直接运行新版即可继续使用旧配置和价格。旧版的 `runtime`、`ui-profile` 目录不会被新版修改。服务只监听 `127.0.0.1`，自动选择空闲端口，不要求管理员权限。

## 开发机重新构建

开发机需要 Windows x64、Node 24、已安装项目依赖及与 Patchright 对应的 Chromium，不再需要 .NET SDK。运行：

```powershell
npm run build:exe
```

构建脚本只复制允许的程序目录，解引用 pnpm 链接并打包完整依赖，排除配置、输出、日志和开发缓存，再用 electron-builder 生成 portable EXE。生成的 SHA-256 校验文件用于核对复制后的 EXE 是否完整。`build/electron-release` 是构建中间产物，分发时只需复制 `dist` 中最终 EXE。

开发调试桌面窗口：`npm run desktop`。验证独立运行和持久化：`npm run test:exe`；加 `-- --with-refresh` 会使用开发机已保存的账号执行实际无头采集，结束后删除隔离测试目录中的账号副本。

诊断参数（普通使用无需填写）：

```text
XinlePriceDashboard-Electron.exe --data-root C:\Temp\XinleTest --no-window
```

此模式不打开看板窗口，后台服务的本地地址会写入指定目录的 `session.json`。不要把真实登录配置加入源码或分发文件。

桌面窗口采用 [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)，打包采用 [electron-builder portable](https://www.electron.build/nsis.html)。窗口启用沙箱、上下文隔离及同源限制，参见 [Electron 安全说明](https://www.electronjs.org/docs/latest/tutorial/security)。采集浏览器运行文件随程序分发。
