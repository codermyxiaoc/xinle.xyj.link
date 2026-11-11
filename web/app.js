"use strict";

const $ = (selector) => document.querySelector(selector);
const state = { data: null, month: "", date: "", type: "all", refreshing: false, pollTimer: null, lastCompletion: null };
let pricesRequestRevision = 0;
const money = (value) => Number(value).toFixed(2);
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const weekdayFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

// 原生 select 保留筛选状态与 change 事件；可见控件统一使用自定义选项样式。
const filterDropdowns = new Map();

function enhanceFilterSelect(select) {
  const wrapper = element("div", "custom-select");
  const trigger = element("button", "custom-select-trigger");
  trigger.type = "button";
  trigger.id = `${select.id}-trigger`;
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-label", select.getAttribute("aria-label") || "选择选项");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", `${select.id}-listbox`);
  const valueLabel = element("span", "custom-select-value");
  const arrow = element("span", "custom-select-arrow");
  arrow.setAttribute("aria-hidden", "true");
  trigger.append(valueLabel, arrow);
  const menu = element("div", "custom-select-menu");
  menu.id = `${select.id}-listbox`;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", trigger.getAttribute("aria-label"));
  menu.hidden = true;
  select.after(wrapper);
  wrapper.append(trigger, menu);
  select.hidden = true;
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  const label = select.closest("label");
  if (label) label.htmlFor = trigger.id;

  let opened = false;
  let activeIndex = -1;
  let searchText = "";
  let searchTime = 0;
  const availableIndexes = () => [...select.options].flatMap((option, index) => option.disabled ? [] : [index]);
  const setActive = (index, scroll = false) => {
    activeIndex = index;
    [...menu.children].forEach((option, optionIndex) => option.classList.toggle("is-active", optionIndex === index));
    if (opened && menu.children[index]) {
      trigger.setAttribute("aria-activedescendant", menu.children[index].id);
      if (scroll) menu.children[index].scrollIntoView({ block: "nearest" });
    } else trigger.removeAttribute("aria-activedescendant");
  };
  const positionMenu = () => {
    const rect = trigger.getBoundingClientRect();
    const estimatedHeight = Math.min(280, select.options.length * 42 + 12);
    const below = window.innerHeight - rect.bottom;
    wrapper.classList.toggle("opens-up", below < estimatedHeight && rect.top > below);
    wrapper.classList.toggle("align-right", rect.left + Math.max(rect.width, 190) > window.innerWidth - 16);
  };
  const close = () => {
    opened = false;
    menu.hidden = true;
    wrapper.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
  };
  const open = () => {
    if (trigger.disabled) return;
    for (const dropdown of filterDropdowns.values()) if (dropdown.trigger !== trigger) dropdown.close();
    opened = true;
    menu.hidden = false;
    wrapper.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    positionMenu();
    const available = availableIndexes();
    setActive(available.includes(select.selectedIndex) ? select.selectedIndex : available[0] ?? -1, true);
  };
  const choose = (index) => {
    const option = select.options[index];
    if (!option || option.disabled) return;
    const changed = select.value !== option.value;
    select.value = option.value;
    close();
    trigger.focus({ preventScroll: true });
    if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
    else sync();
  };
  const sync = () => {
    const activeValue = menu.children[activeIndex]?.dataset.value;
    valueLabel.textContent = select.selectedOptions[0]?.textContent || "请选择";
    trigger.disabled = select.disabled || availableIndexes().length === 0;
    menu.replaceChildren(...[...select.options].map((option, index) => {
      const item = element("div", "custom-select-option");
      item.id = `${select.id}-option-${index}`;
      item.dataset.index = String(index);
      item.dataset.value = option.value;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.selected));
      if (option.disabled) item.setAttribute("aria-disabled", "true");
      const check = element("span", "custom-select-check", "✓");
      check.setAttribute("aria-hidden", "true");
      item.append(element("span", "custom-select-option-label", option.textContent), check);
      return item;
    }));
    if (trigger.disabled) close();
    const oldIndex = [...select.options].findIndex((option) => option.value === activeValue && !option.disabled);
    setActive(opened && oldIndex >= 0 ? oldIndex : select.selectedIndex);
    if (opened) positionMenu();
  };
  trigger.addEventListener("click", () => opened ? close() : open());
  trigger.addEventListener("keydown", (event) => {
    const available = availableIndexes();
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const wasOpen = opened;
      if (!opened) open();
      let next = activeIndex;
      if (event.key === "Home") next = available[0];
      else if (event.key === "End") next = available.at(-1);
      else if (wasOpen) {
        const position = available.indexOf(activeIndex);
        next = available[Math.min(available.length - 1, Math.max(0, position + (event.key === "ArrowDown" ? 1 : -1)))];
      }
      setActive(next ?? -1, true);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (opened) choose(activeIndex); else open();
    } else if (event.key === "Escape") {
      if (opened) event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      close();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      searchText = now - searchTime > 700 ? event.key : searchText + event.key;
      searchTime = now;
      if (!opened) open();
      const index = available.find((value) => select.options[value].textContent.replace(/\s/g, "").toLowerCase().startsWith(searchText.toLowerCase()));
      if (index !== undefined) setActive(index, true);
    }
  });
  menu.addEventListener("mousedown", (event) => event.preventDefault());
  menu.addEventListener("click", (event) => {
    // 菜单在 label 内部，取消 label 的默认激活，避免选中后再次打开。
    event.preventDefault();
    const option = event.target.closest(".custom-select-option");
    if (option && menu.contains(option)) choose(Number(option.dataset.index));
  });
  wrapper.addEventListener("focusout", (event) => {
    if (!wrapper.contains(event.relatedTarget)) close();
  });
  const dropdown = { trigger, wrapper, sync, close };
  filterDropdowns.set(select.id, dropdown);
  sync();
  return dropdown;
}

document.addEventListener("pointerdown", (event) => {
  for (const dropdown of filterDropdowns.values()) if (!dropdown.wrapper.contains(event.target)) dropdown.close();
});
window.addEventListener("resize", () => {
  for (const dropdown of filterDropdowns.values()) dropdown.close();
});

async function request(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  let payload;
  try { payload = await response.json(); } catch { throw new Error("暂时无法读取数据，请稍后重试。"); }
  if (!response.ok) {
    const error = new Error(payload.error || payload.message || "请求未完成，请稍后重试。");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function rows() {
  return (state.data?.rows || []).filter((row) => Number.isFinite(Number(row.mallPrice)) && row.mallPrice !== null && /^\d{4}-\d{2}-\d{2}$/.test(row.date));
}
function allDates() { return [...new Set(rows().map((row) => row.date))].sort(); }
function filteredDates() { return allDates().filter((date) => date.startsWith(state.month) && (!state.date || date === state.date)); }
function priceAvailable(row) { return row.valid === 1 && row.includedInPrices === true && row.stock !== 0; }
function conflict(product) { return product?.ticketTypeSource !== "local" && (product?.ticketType === "CHILDREN" && product.name?.includes("成人") || product?.ticketType === "ADULT" && product.name?.includes("儿童")); }
function currentDate() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }

function populateFilters() {
  const dates = allDates();
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))];
  if (!months.includes(state.month)) state.month = months.includes(currentDate().slice(0, 7)) ? currentDate().slice(0, 7) : months[0] || "";
  const monthFilter = $("#month-filter");
  monthFilter.replaceChildren();
  for (const month of months) monthFilter.append(new Option(`${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`, month));
  if (!months.length) monthFilter.append(new Option("暂无可选月份", ""));
  monthFilter.value = state.month;
  const monthDates = dates.filter((date) => date.startsWith(state.month));
  if (!monthDates.includes(state.date)) state.date = "";
  const dateFilter = $("#date-filter");
  dateFilter.replaceChildren(new Option("当月全部日期", ""));
  for (const date of monthDates) {
    const weekday = weekdayFormatter.format(new Date(`${date}T12:00:00+08:00`));
    dateFilter.append(new Option(`${Number(date.slice(5, 7))} 月 ${Number(date.slice(8))} 日 · ${weekday}`, date));
  }
  dateFilter.value = state.date;
  filterDropdowns.get(monthFilter.id)?.sync();
  filterDropdowns.get(dateFilter.id)?.sync();
}

function renderSummary(dates) {
  const products = Object.values(state.data?.products || {});
  const adultCount = products.filter((product) => product.group === "adult").length;
  const childCount = products.filter((product) => product.group === "children").length;
  $("#channel-count").textContent = String(products.length);
  $("#channel-detail").textContent = `成人 ${adultCount} 个 · 儿童 ${childCount} 个`;
  $("#date-count").textContent = String(allDates().length);
  const range = allDates();
  $("#date-range").textContent = range.length ? `${range[0].replaceAll("-", ".")} — ${range.at(-1).replaceAll("-", ".")}` : "尚无价格日期";
  for (const group of ["adult", "children"]) {
    const values = rows().filter((row) => row.group === group && dates.includes(row.date) && priceAvailable(row)).map((row) => Number(row.mallPrice));
    $(`#${group}-lowest`).textContent = values.length ? money(Math.min(...values)) : "—";
  }
  const destinations = [...new Set(products.map((product) => product.spotName).filter(Boolean))];
  $("#destination").textContent = destinations.length ? `${destinations.join(" / ")} · 成人与儿童分开比较，找到当天更合适的报价。` : "成人与儿童分开比较，找到当天更合适的报价。";
  const fetchedAt = state.data?.fetchedAt;
  $("#updated-at").textContent = fetchedAt && Number.isFinite(Date.parse(fetchedAt)) ? `最后更新 ${dateFormatter.format(new Date(fetchedAt))}` : "尚无已保存的价格";
}

function renderNotices() {
  const warnings = (state.data?.warnings || []).map((warning) => {
    const id = String(warning).match(/商品 (\d+)/)?.[1];
    const product = id && state.data?.products?.[id];
    if (product?.ticketTypeSource === "local" && (/ticket_type=.*冲突/.test(warning) || /票种 .*未归入成人\/儿童/.test(warning))) return null;
    if (product && conflict(product)) return `渠道 #${id} 标注为${product.group === "children" ? "儿童票" : "成人票"}，但产品名称为“${product.name}”，请预订前核对适用人群。`;
    if (/stock=0/.test(warning)) return `渠道 #${id || "未知"} 存在暂无库存的日期，已在报价旁标注。`;
    if (/valid=/.test(warning)) return `渠道 #${id || "未知"} 存在状态待确认的日期，请核对可预订状态。`;
    return String(warning);
  }).filter(Boolean);
  if (state.data?.collectionStatus === "partial") warnings.unshift("当前为部分渠道数据，部分渠道未能更新。请手动刷新后再比较。");
  const other = Object.values(state.data?.products || {}).filter((product) => product.group === "other");
  if (other.length) warnings.push(`${other.length} 个渠道的票种无法归入成人或儿童，已保留在导出数据中，请核对票种。`);
  $("#data-notice").hidden = !warnings.length;
  $("#notice-title").textContent = `${warnings.length} 项数据说明 · 比价前请留意票种与适用条件`;
  $("#notice-list").replaceChildren(...warnings.map((warning) => element("li", "", warning)));
}

function channelLabel(product) {
  const limit = Number(product?.limitDays);
  if (product?.limitDays !== null && product?.limitDays !== undefined && Number.isFinite(limit) && limit > 0) return `提前 ${limit} 天预订`;
  if (product?.limitDays !== null && product?.limitDays !== undefined && limit === 0) return "当天可预订渠道";
  return "渠道报价";
}

function renderTicketCard(date, group) {
  const name = group === "adult" ? "成人票" : "儿童票";
  const card = element("section", `ticket-card ${group}-card`);
  card.dataset.group = group;
  card.setAttribute("aria-label", `${date} ${name}价格排序`);
  const records = rows().filter((row) => row.date === date && row.group === group).sort((a, b) => Number(a.mallPrice) - Number(b.mallPrice) || Number(a.goodsId) - Number(b.goodsId));
  const available = records.filter(priceAvailable);
  const lowest = available.length ? Number(available[0].mallPrice) : null;
  const header = element("div", "ticket-header");
  const title = element("h3", "ticket-title");
  title.append(element("span", "type-icon", group === "adult" ? "成" : "童"), document.createTextNode(name), element("span", "channel-counter", `${records.length} 个渠道`));
  header.append(title, element("span", "price-order-label", "价格 ↑"));
  card.append(header);
  if (!records.length) { card.append(element("div", "no-tickets", "当天暂无该票种报价")); return card; }
  const list = element("ol", "channel-list");
  for (const row of records) {
    const product = state.data.products[String(row.goodsId)] || {};
    const availableRow = priceAvailable(row);
    const rank = availableRow ? available.filter((entry) => Number(entry.mallPrice) < Number(row.mallPrice)).length + 1 : null;
    const best = availableRow && Number(row.mallPrice) === lowest;
    const item = element("li", `channel-row${best ? " is-best" : ""}${availableRow ? "" : " is-unavailable"}`);
    item.dataset.goodsId = String(row.goodsId);
    item.dataset.price = String(row.mallPrice);
    item.dataset.rank = rank === null ? "" : String(rank);
    item.append(element("span", `rank-number${best ? " rank-first" : ""}`, rank === null ? "—" : String(rank).padStart(2, "0")));
    const info = element("div", "channel-info");
    const fullTitle = product.name ? `${product.name}-${row.goodsId}` : `渠道-${row.goodsId}`;
    const heading = element("p", "channel-title", fullTitle);
    info.append(heading, element("p", "channel-name", channelLabel(product)));
    const status = element("div", "channel-status");
    if (row.valid !== 1 || row.includedInPrices !== true) status.append(element("span", "availability-warning", "当前不可预订"));
    else if (row.stock === 0) status.append(element("span", "availability-warning", "暂无库存"));
    else if (Number.isInteger(row.stock) && row.stock > 0) status.append(element("span", "", `库存 ${row.stock}`));
    else status.append(element("span", "", "库存未标注"));
    if (product.ticketTypeSource === "local") status.append(element("span", "local-ticket-type-label", `本地设为${product.group === "adult" ? "成人" : "儿童"}`));
    else if (conflict(product)) status.append(element("span", "conflict-label", "票种需核对"));
    info.append(status);
    const price = element("div", "channel-price");
    price.append(element("span", "currency", "¥"), element("strong", "", money(row.mallPrice)));
    if (best) price.append(element("span", "best-label", available.filter((entry) => Number(entry.mallPrice) === lowest).length > 1 ? "并列最低" : "当日最低"));
    item.append(info, price);
    list.append(item);
  }
  card.append(list);
  return card;
}

function renderDay(date) {
  const section = element("article", "day-section");
  section.dataset.date = date;
  section.id = `date-${date}`;
  const aside = element("div", "date-aside");
  aside.append(element("span", "date-month", `${date.slice(0, 4)} / ${date.slice(5, 7)}`));
  const dayline = element("div", "date-dayline");
  const parsed = new Date(`${date}T12:00:00+08:00`);
  const weekday = weekdayFormatter.format(parsed);
  dayline.append(element("span", "date-number", date.slice(8)), element("span", `date-weekday${/六|日/.test(weekday) ? " weekend" : ""}`, weekday));
  aside.append(dayline);
  if (date === currentDate()) aside.append(element("span", "today-label", "今天"));
  const cards = element("div", `day-tickets${state.type === "all" ? "" : " single-type"}`);
  for (const group of state.type === "all" ? ["adult", "children"] : [state.type]) cards.append(renderTicketCard(date, group));
  section.append(aside, cards);
  return section;
}

function render() {
  populateFilters();
  const dates = filteredDates();
  renderSummary(dates);
  renderNotices();
  $("#results-count").textContent = `共 ${dates.length} 个日期${state.date ? "" : state.month ? ` · ${state.month.slice(0, 4)} 年 ${Number(state.month.slice(5))} 月` : ""}`;
  const list = $("#daily-list");
  if (!dates.length) {
    const empty = element("div", "empty-state");
    empty.append(element("strong", "", "暂时没有可比较的价格"), element("p", "", "点击「手动刷新价格」获取最新报价，或尝试其他日期。"));
    list.replaceChildren(empty);
  } else list.replaceChildren(...dates.map(renderDay));
}

async function loadPrices() {
  const current = ++pricesRequestRevision;
  try {
    const data = await request("/api/prices");
    if (current !== pricesRequestRevision) return false;
    if (!data || !Array.isArray(data.rows) || !data.products) throw new Error("价格文件暂时无法读取，请刷新重试。");
    state.data = data;
    $("#error-banner").hidden = true;
    render();
    return true;
  } catch (error) {
    if (current !== pricesRequestRevision) return false;
    if (!state.data) render();
    $("#error-banner").textContent = error.status === 404 ? "还没有保存的价格数据。点击「手动刷新价格」开始首次采集。" : `价格读取失败：${error.message}${state.data ? "。已保留上次显示的数据。" : ""}`;
    $("#error-banner").hidden = false;
    return false;
  }
}

function showRefreshStatus(status) {
  state.refreshing = status.status === "running";
  $("#refresh-button").disabled = state.refreshing;
  $("#refresh-button-label").textContent = state.refreshing ? "正在刷新价格…" : "手动刷新价格";
  const banner = $("#refresh-status");
  banner.hidden = status.status === "idle";
  banner.classList.toggle("is-error", status.status === "error");
  const progress = status.progress || {};
  if (state.refreshing) {
    $("#refresh-message").textContent = "正在获取最新渠道报价";
    $("#refresh-detail").textContent = progress.total > 0 ? `已更新 ${progress.current || 0} / ${progress.total} 个渠道，完成后自动保存` : "正在连接票务平台，请稍候…";
    $("#progress-track").hidden = false;
    $("#progress-fill").style.width = progress.total > 0 ? `${Math.min(100, Math.max(0, (progress.current || 0) / progress.total * 100))}%` : "6%";
  } else if (status.status === "success") {
    $("#refresh-message").textContent = "最新价格已保存";
    $("#refresh-detail").textContent = "页面已同步更新";
    $("#progress-track").hidden = true;
  } else if (status.status === "error") {
    $("#refresh-message").textContent = "本次刷新未完成";
    $("#refresh-detail").textContent = `${status.error || status.message || "请稍后再试"}。已保留上次保存的数据。`;
    $("#progress-track").hidden = true;
  }
}

async function pollRefresh() {
  clearTimeout(state.pollTimer);
  try {
    const status = await request("/api/refresh");
    const wasRefreshing = state.refreshing;
    showRefreshStatus(status);
    if (status.status === "running") {
      state.pollTimer = setTimeout(pollRefresh, 1100);
    } else if (status.status === "success" && (wasRefreshing || state.lastCompletion !== status.finishedAt)) {
      state.lastCompletion = status.finishedAt;
      await loadPrices();
    }
  } catch (error) {
    showRefreshStatus({ status: "error", error: "暂时无法连接刷新服务，请稍后重试" });
  }
}

async function refreshPrices() {
  if (state.refreshing) return;
  showRefreshStatus({ status: "running", progress: { current: 0, total: 0 } });
  try {
    const status = await request("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    showRefreshStatus(status);
    if (status.status === "success") await loadPrices();
    else if (status.status === "running") await pollRefresh();
  } catch (error) {
    showRefreshStatus({ status: "error", error: error.message });
  }
}

$("#month-filter").addEventListener("change", (event) => { state.month = event.target.value; state.date = ""; render(); });
$("#date-filter").addEventListener("change", (event) => { state.date = event.target.value; render(); });
for (const button of document.querySelectorAll("[data-type]")) button.addEventListener("click", () => {
  state.type = button.dataset.type;
  for (const item of document.querySelectorAll("[data-type]")) { const active = item === button; item.classList.toggle("active", active); item.setAttribute("aria-pressed", String(active)); }
  render();
});
$("#refresh-button").addEventListener("click", refreshPrices);
window.addEventListener("ticket-types-saved", () => { void loadPrices(); });
enhanceFilterSelect($("#month-filter"));
enhanceFilterSelect($("#date-filter"));
void loadPrices();
void pollRefresh();
