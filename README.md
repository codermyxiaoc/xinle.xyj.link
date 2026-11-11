# xinle.xyj.link

特权门票每日价格采集与渠道比价看板，支持成人/儿童分类、本地票种设置和 Electron 桌面版。

## 从源码运行

安装 Node.js 24 和 pnpm 后，在项目目录执行：

```powershell
pnpm install --frozen-lockfile
npm start
```

打开 <http://127.0.0.1:3186>，在「登录配置」中保存自己的账号密码，再点击「手动刷新价格」。开发模式默认使用本机 Edge；也可通过 `XINLE_BROWSER_PATH` 指定 Chromium 可执行文件。

仓库仅包含源码、构建脚本和测试源码，不包含 EXE、已安装依赖、账号密码、抓取数据或测试日志。构建桌面版之前，先准备 Electron 和采集浏览器：

```powershell
node node_modules/electron/install.js
pnpm exec patchright install chromium
npm run build:exe
```

## Windows EXE

Windows 10 / 11 64 位可直接运行 `dist/XinlePriceDashboard-Electron.exe`，内置 Electron 桌面窗口、Node 和采集用 Chromium。界面不显示 Chrome 测试版提示，价格采集全程无头运行，不弹出浏览器。首次打开后填写「登录配置」，再手动刷新。发行包不含开发电脑账号密码，数据保存在当前用户的 `%LOCALAPPDATA%\XinlePriceDashboard\data`，与旧版 EXE 共用数据目录。

构建命令：`npm run build:exe`。详细说明见 [Windows 发行版说明](packaging/WINDOWS-EXE.md)。

## 本地价格看板

运行 `npm start` 后打开 <http://127.0.0.1:3186>。

页面按日期分别展示成人票和儿童票，每个商品 ID 作为一个渠道，按日历价格从低到高排序。同价渠道并列排名，保留产品名称、提前预订天数及源数据类型冲突提示。可按月份、日期查看。

刷新按钮左侧的“登录配置”可编辑账号和密码。保存后，后续登录与价格采集优先使用该配置，不需要重启服务；正在执行的采集继续使用启动时的账号。已有密码时留空可保留原密码，密码不会回显到页面。

“票种设置”列出已采集的全部渠道，可按名称或编号搜索，逐个选择成人票、儿童票或“跟随接口”。本地票种按商品 ID 保存，立即应用于比价、统计和导出 JSON，后续采集及程序重启仍优先使用；渠道暂时下架不会删除其设置。恢复“跟随接口”后按接口原票种分类。刷新过程中也能保存设置，刷新完成时会按最新本地设置发布完整结果。

点击“手动刷新”后，服务会在后台无头运行登录和采集流程，显示进度。完成全部渠道采集后，原子替换 `output/ticket-prices.json`，同时更新其他导出文件，页面自动显示最新数据。刷新期间可继续浏览旧数据；刷新失败会保留上一次成功的数据。重复点击或多个页面同时刷新只启动一次采集。

服务只监听本机，账号配置不会发送到页面。`PORT` 环境变量可更改端口。停止运行终端即可停止服务，已保存的 JSON 仍可在下次启动时加载。

## 命令行采集

在项目目录运行：

```powershell
npm run prices
```

脚本优先使用页面保存的登录配置，没有保存过时兼容 `.env.local` 中的账号。使用项目已配置的 Edge（`--no-proxy-server`），登录后重新访问首页，再打开“门票预订 → 我的特权产品”。它会读取所有产品列表分页，逐个查询预订日历使用的价格接口。仅查询价格，不提交订单。

默认采集不显示浏览器，完成后自动退出；调试时运行 `npm run prices -- --visible`，需要保留窗口时运行 `npm run prices -- --visible --keep-open`。单独登录仍使用 `npm run login`。

## 导出文件

- `output/prices-by-date.json`：`adult / children / other → 商品ID → YYYY-MM-DD → 价格`。
- `output/prices-by-month.json`：`adult / children / other → 商品ID → YYYY-MM → 日号 → 价格`，适合按用户示例读取某个月的数据。
- `output/ticket-prices.json`：完整结果，含商品名称、原始票种、每日价格明细、库存/有效性、统计、警告及采集状态。
- `output/ticket-prices.csv`：供 Excel 查看的一日一行明细。

所有金额单位为元。简表使用预订日历前端实际显示的 `mall_price`；完整明细也保留 `b2b_price`（平台价）和 `market_price`（门市价）。不会用列表上的起始价替代每日价格。

价格请求为 `POST /scm/goods/getGoodsPrice`，参数是 `goods_id`、空的 `product_scan_goods_id` 和 `scanCode`。请求不限定月份，保留接口当次返回的全部日期；未返回的日期不会填零或根据邻日推算。

`prices` 和 `dayNumbers` 只收录 `valid=1` 的日期，全部状态均保留在 `rows`。库存为 `-1` 不会被删除；库存为 `0` 会保留记录并给出警告，价格记录不等于保证仍有库存。

成人/儿童优先按 `config/ticket-types.json` 中的本地设置分类，未设置的渠道按接口 `ticket_type` 分类。接口原票种保留为 `sourceTicketType` / `sourceGroup`，有效票种使用 `ticketType` / `group`，`ticketTypeSource` 标记 `local` 或 `remote`。未设置的渠道若名称与票种冲突，会在 `warnings` 中提示核对。例如商品 1036 的接口类型为 `CHILDREN`，名称包含“成人票”；可在“票种设置”中自行确认并改为成人票，系统不会根据名称自动更改。

每次成功采集使用临时文件与重命名替换同名导出文件，主 JSON 最后发布；旧主文件备份为 `output/ticket-prices.previous.json`。部分接口失败或数据校验失败时返回非零退出码，保留上一次成功的数据，不发布不完整结果。

页面保存的账号配置持久化在本机 `config/login.json`，已被 Git 忽略且不作为静态文件提供给浏览器。`.env.local` 中的 `XINLE_USERNAME` 和 `XINLE_PASSWORD` 作为未保存网页配置时的兼容来源。配置接口只返回账号和是否已设置密码，日志不输出凭据。

验证数据转换：`npm run test:prices`。

验证本地服务、刷新并发和持久化：`npm run test:dashboard`。

验证本地票种、刷新优先级与导出一致性：`npm run test:ticket-types`。
