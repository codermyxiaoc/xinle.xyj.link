"use strict";

const $ = (selector) => document.querySelector(selector);
const state = { data: null, destination: null, month: "", date: "", type: "all", view: "list", refreshing: false, pollTimer: null, lastCompletion: null };
const ticketGroups = {
  adult_1d: { name: "1日成人", audience: "adult", icon: "成" },
  children_1d: { name: "1日儿童", audience: "children", icon: "童" },
  adult_1_5d: { name: "1.5日成人", audience: "adult", icon: "成" },
  children_1_5d: { name: "1.5日儿童", audience: "children", icon: "童" },
  other: { name: "待设置", audience: "other", icon: "?" },
};
const classifiedGroups = Object.keys(ticketGroups).filter((group) => group !== "other");
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
function productFor(row) { return state.data?.products?.[String(row.goodsId)] || row; }
function destinationFor(product) {
  const spotId = product?.spotId;
  const name = product?.destinationName || product?.spotName || "未标注地区";
  const key = product?.destinationKey || (Number.isSafeInteger(Number(spotId)) && Number(spotId) > 0 ? `spot:${spotId}` : product?.spotName ? `name:${product.spotName}` : "unknown");
  return { key, name };
}
function groupFor(product) { return Object.hasOwn(ticketGroups, product?.group) ? product.group : "other"; }
function matchesFilters(product) {
  return (!state.destination || destinationFor(product).key === state.destination) && (state.type === "all" || groupFor(product) === state.type);
}
function scopedRows() { return rows().filter((row) => matchesFilters(productFor(row))); }
function scopedProducts() { return Object.values(state.data?.products || {}).filter(matchesFilters); }
function destinations() {
  const result = new Map();
  for (const product of Object.values(state.data?.products || {})) { const destination = destinationFor(product); result.set(destination.key, destination); }
  return [...result.values()];
}
function allDates() { return [...new Set(scopedRows().map((row) => row.date))].sort(); }
function filteredDates() { return allDates().filter((date) => date.startsWith(state.month) && (!state.date || date === state.date)); }
function priceAvailable(row) { return row.valid === 1 && row.includedInPrices === true && row.stock !== 0; }
function currentDate() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }

function populateFilters() {
  const places = destinations();
  if (state.destination === null || (state.destination && !places.some((place) => place.key === state.destination))) {
    state.destination = places.find((place) => place.name === "北京环球度假区")?.key ?? (places.length ? "" : null);
  }
  const destinationFilter = $("#destination-filter");
  const focusedDestination = destinationFilter.contains(document.activeElement) ? document.activeElement.dataset.destination : undefined;
  destinationFilter.replaceChildren(...[{ key: "", name: "全部地区" }, ...places].map((place) => {
    const selected = place.key === (state.destination ?? "");
    const button = element("button", selected ? "active" : "", place.name);
    button.type = "button";
    button.dataset.destination = place.key;
    button.setAttribute("aria-pressed", String(selected));
    return button;
  }));
  if (focusedDestination !== undefined) {
    [...destinationFilter.children].find((button) => button.dataset.destination === focusedDestination)?.focus({ preventScroll: true });
  }
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
  const products = scopedProducts();
  const pending = products.filter((product) => groupFor(product) === "other").length;
  $("#channel-count").textContent = String(products.length);
  $("#channel-detail").textContent = `${products.length - pending} 个已分类 · ${pending} 个待设置`;
  $("#date-count").textContent = String(dates.length);
  const range = dates;
  $("#date-range").textContent = range.length ? `${range[0].replaceAll("-", ".")} — ${range.at(-1).replaceAll("-", ".")}` : "尚无价格日期";
  for (const group of classifiedGroups) {
    const values = state.destination ? scopedRows().filter((row) => groupFor(productFor(row)) === group && dates.includes(row.date) && priceAvailable(row)).map((row) => Number(row.mallPrice)) : [];
    $(`#${group}-lowest`).textContent = values.length ? money(Math.min(...values)) : "—";
  }
  for (const caption of document.querySelectorAll(".selection-caption")) caption.textContent = state.destination ? "当前地区与筛选日期内" : "选择旅游地区后查看最低价";
  const place = destinations().find((item) => item.key === state.destination);
  $("#destination").textContent = `${place ? place.name : "按旅游地区分别展示"} · 按游玩时长与成人、儿童独立比较。`;
  const fetchedAt = state.data?.fetchedAt;
  $("#updated-at").textContent = fetchedAt && Number.isFinite(Date.parse(fetchedAt)) ? `最后更新 ${dateFormatter.format(new Date(fetchedAt))}` : "尚无已保存的价格";
}

function renderNotices() {
  const warnings = (state.data?.warnings || []).map((warning) => {
    const id = String(warning).match(/商品 (\d+)/)?.[1];
    const product = id && state.data?.products?.[id];
    if (product && !matchesFilters(product)) return null;
    if (product?.ticketTypeSource === "local" && (/ticket_type=.*冲突/.test(warning) || /票种 .*未归入成人\/儿童/.test(warning))) return null;
    if (/stock=0/.test(warning)) return `渠道 #${id || "未知"} 存在暂无库存的日期，已在报价旁标注。`;
    if (/valid=/.test(warning)) return `渠道 #${id || "未知"} 存在状态待确认的日期，请核对可预订状态。`;
    return String(warning);
  }).filter(Boolean);
  if (state.data?.collectionStatus === "partial") warnings.unshift("当前为部分渠道数据，部分渠道未能更新。请手动刷新后再比较。");
  const other = scopedProducts().filter((product) => groupFor(product) === "other");
  if (other.length) warnings.push(`${other.length} 个渠道的游玩时长或适用人群待确认，已列入「待设置」，不参与四类票种的价格排名。可在「票种设置」中逐一指定。`);
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

function configureTicket(goodsId) { window.dispatchEvent(new CustomEvent("open-ticket-types", { detail: { goodsId } })); }

function settingsButton(goodsId, label = "设置票种") {
  const button = element("button", "pending-type-action", label);
  button.type = "button";
  button.setAttribute("aria-haspopup", "dialog");
  button.addEventListener("click", () => configureTicket(goodsId));
  return button;
}

function renderTicketCard(date, group, destination) {
  const { name, audience, icon } = ticketGroups[group];
  const isPending = group === "other";
  const card = element("section", `ticket-card ${audience}-card`);
  card.dataset.group = group;
  card.dataset.destination = destination.key;
  card.setAttribute("aria-label", `${date} ${destination.name} ${name}${isPending ? "渠道" : "价格排序"}`);
  const records = scopedRows().filter((row) => row.date === date && groupFor(productFor(row)) === group && destinationFor(productFor(row)).key === destination.key).sort((a, b) => isPending ? Number(a.goodsId) - Number(b.goodsId) : Number(a.mallPrice) - Number(b.mallPrice) || Number(a.goodsId) - Number(b.goodsId));
  const available = records.filter(priceAvailable);
  const lowest = available.length ? Number(available[0].mallPrice) : null;
  const header = element("div", "ticket-header");
  const title = element("h3", "ticket-title");
  title.append(element("span", "type-icon", icon), document.createTextNode(name), element("span", "channel-counter", `${records.length} 个渠道`));
  header.append(title, element("span", "price-order-label", isPending ? "确认票种后参与比价" : "价格 ↑"));
  card.append(header);
  if (!records.length) { card.append(element("div", "no-tickets", "当天暂无该票种报价")); return card; }
  const list = element("ol", "channel-list");
  for (const row of records) {
    const product = state.data.products[String(row.goodsId)] || {};
    const availableRow = priceAvailable(row);
    const rank = !isPending && availableRow ? available.filter((entry) => Number(entry.mallPrice) < Number(row.mallPrice)).length + 1 : null;
    const best = !isPending && availableRow && Number(row.mallPrice) === lowest;
    const item = element("li", `channel-row${best ? " is-best" : ""}${availableRow || isPending ? "" : " is-unavailable"}`);
    item.dataset.goodsId = String(row.goodsId);
    item.dataset.price = String(row.mallPrice);
    item.dataset.rank = rank === null ? "" : String(rank);
    item.append(element("span", `rank-number${best ? " rank-first" : ""}`, rank === null ? "—" : String(rank).padStart(2, "0")));
    const info = element("div", "channel-info");
    const fullTitle = product.name ? product.name.endsWith(`-${row.goodsId}`) ? product.name : `${product.name}-${row.goodsId}` : `渠道-${row.goodsId}`;
    const heading = element("p", "channel-title", fullTitle);
    info.append(heading, element("p", "channel-name", channelLabel(product)));
    const status = element("div", "channel-status");
    if (row.valid !== 1 || (!isPending && row.includedInPrices !== true)) status.append(element("span", "availability-warning", "当前不可预订"));
    else if (row.stock === 0) status.append(element("span", "availability-warning", "暂无库存"));
    else if (Number.isInteger(row.stock) && row.stock > 0) status.append(element("span", "", `库存 ${row.stock}`));
    else status.append(element("span", "", "库存未标注"));
    if (product.ticketTypeSource === "local") status.append(element("span", "local-ticket-type-label", `本地设为${ticketGroups[groupFor(product)].name}`));
    if (isPending) status.append(settingsButton(row.goodsId));
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
  const places = element("div", "day-destinations");
  for (const destination of destinations().filter((place) => !state.destination || place.key === state.destination)) {
    const records = scopedRows().filter((row) => row.date === date && destinationFor(productFor(row)).key === destination.key);
    if (!records.length) continue;
    const place = element("section", "destination-section");
    place.dataset.destination = destination.key;
    place.append(element("h3", "destination-heading", destination.name));
    const cards = element("div", `day-tickets${state.type === "all" ? "" : " single-type"}`);
    const groups = state.type === "all" ? [...classifiedGroups, ...(records.some((row) => groupFor(productFor(row)) === "other") ? ["other"] : [])] : [state.type];
    for (const group of groups) cards.append(renderTicketCard(date, group, destination));
    place.append(cards);
    places.append(place);
  }
  section.append(aside, places);
  return section;
}

function changeCalendarMonth(direction) {
  const months = [...new Set(allDates().map((date) => date.slice(0, 7)))];
  const next = months[months.indexOf(state.month) + direction];
  if (!next) return;
  state.month = next;
  state.date = "";
  render();
}

function renderPriceCalendar(destination, group, records) {
  const { name, audience, icon } = ticketGroups[group];
  const calendar = element("section", `price-calendar ${audience}-calendar`);
  calendar.dataset.group = group;
  calendar.dataset.destination = destination.key;
  calendar.setAttribute("aria-label", `${destination.name} ${name} ${state.month} 每日最低价`);
  const header = element("header", "calendar-card-header");
  const title = element("h4", "");
  title.append(element("span", "type-icon", icon), document.createTextNode(name));
  header.append(title, element("span", "calendar-card-caption", "每日最低价"));
  const weekdays = element("div", "calendar-weekdays");
  weekdays.setAttribute("aria-hidden", "true");
  for (const [index, day] of ["日", "一", "二", "三", "四", "五", "六"].entries()) weekdays.append(element("span", index === 0 || index === 6 ? "is-weekend" : "", day));
  const grid = element("div", "calendar-days");
  const dailyMinimums = new Map();
  for (const row of records) {
    if (groupFor(productFor(row)) !== group || !priceAvailable(row)) continue;
    const price = Number(row.mallPrice);
    const previous = dailyMinimums.get(row.date);
    if (previous === undefined || price < previous) dailyMinimums.set(row.date, price);
  }
  const monthMinimum = dailyMinimums.size ? Math.min(...dailyMinimums.values()) : null;
  const [year, month] = state.month.split("-").map(Number);
  const firstWeekday = new Date(`${state.month}-01T00:00:00Z`).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const blank = () => {
    const cell = element("span", "calendar-blank");
    cell.setAttribute("aria-hidden", "true");
    return cell;
  };
  for (let index = 0; index < firstWeekday; index++) grid.append(blank());
  for (let number = 1; number <= daysInMonth; number++) {
    const date = `${state.month}-${String(number).padStart(2, "0")}`;
    const price = dailyMinimums.get(date);
    const available = price !== undefined;
    const day = element("button", "calendar-day");
    day.type = "button";
    day.dataset.date = date;
    day.disabled = !available;
    day.classList.toggle("has-price", available);
    day.classList.toggle("is-today", date === currentDate());
    day.classList.toggle("is-selected", date === state.date);
    day.classList.toggle("is-month-lowest", available && price === monthMinimum);
    day.setAttribute("aria-pressed", String(date === state.date));
    if (date === currentDate()) day.setAttribute("aria-current", "date");
    const weekday = (firstWeekday + number - 1) % 7;
    day.append(element("span", `calendar-day-number${weekday === 0 || weekday === 6 ? " is-weekend" : ""}`, date === currentDate() ? "今天" : number));
    if (available) {
      day.dataset.price = String(price);
      day.append(element("span", "calendar-day-price", `¥${money(price)}`));
      day.setAttribute("aria-label", `${date} ${destination.name} ${name} 最低 ${money(price)} 元，查看当天渠道报价`);
      day.addEventListener("click", () => {
        state.date = date;
        render();
        const heading = $("#calendar-selection h3");
        heading?.focus({ preventScroll: true });
        $("#calendar-selection").scrollIntoView({ block: "start", behavior: "smooth" });
      });
    } else {
      day.append(element("span", "calendar-day-empty", "暂无"));
      day.setAttribute("aria-label", `${date} ${destination.name} ${name} 暂无可预订报价`);
    }
    grid.append(day);
  }
  const trailing = (7 - (firstWeekday + daysInMonth) % 7) % 7;
  for (let index = 0; index < trailing; index++) grid.append(blank());
  calendar.append(header, weekdays, grid);
  return calendar;
}

function renderCalendar() {
  const container = $("#calendar-view");
  container.replaceChildren();
  if (state.type === "other") {
    const pending = element("div", "empty-state");
    pending.append(element("strong", "", "请先确认渠道票种"), element("p", "", "待设置渠道尚不能按票种比较最低价，可先设置票种，或切回列表查看原始报价。"), settingsButton(undefined, "设置票种"));
    container.append(pending);
    return;
  }
  if (!state.month) {
    const empty = element("div", "empty-state");
    empty.append(element("strong", "", "当前筛选下暂无价格日历"), element("p", "", "可切换旅游地区或票种，也可手动刷新获取最新报价。"));
    container.append(empty);
    return;
  }
  const months = [...new Set(allDates().map((date) => date.slice(0, 7)))];
  const monthIndex = months.indexOf(state.month);
  const toolbar = element("div", "calendar-toolbar");
  const previous = element("button", "calendar-month-prev", "‹");
  const next = element("button", "calendar-month-next", "›");
  previous.type = next.type = "button";
  previous.setAttribute("aria-label", "上个月");
  next.setAttribute("aria-label", "下个月");
  previous.disabled = monthIndex <= 0;
  next.disabled = monthIndex >= months.length - 1;
  previous.addEventListener("click", () => changeCalendarMonth(-1));
  next.addEventListener("click", () => changeCalendarMonth(1));
  toolbar.append(previous, element("h3", "calendar-month-title", `${state.month.slice(0, 4)} 年 ${Number(state.month.slice(5))} 月`), next,
    element("p", "calendar-help", "点击日期查看当天渠道报价 · 暂无表示没有可预订报价"));
  container.append(toolbar);
  const groups = state.type === "all" ? classifiedGroups : [state.type];
  const monthRows = scopedRows().filter((row) => row.date.startsWith(state.month));
  for (const destination of destinations().filter((place) => !state.destination || place.key === state.destination)) {
    const section = element("section", "calendar-destination");
    section.dataset.destination = destination.key;
    section.append(element("h3", "destination-heading", destination.name));
    const cards = element("div", `calendar-cards${groups.length === 1 ? " single-type" : ""}`);
    const records = monthRows.filter((row) => destinationFor(productFor(row)).key === destination.key);
    for (const group of groups) cards.append(renderPriceCalendar(destination, group, records));
    section.append(cards);
    container.append(section);
  }
}

function render() {
  populateFilters();
  const dates = filteredDates();
  renderSummary(dates);
  renderNotices();
  const calendarMode = state.view === "calendar";
  for (const button of document.querySelectorAll("#view-mode [data-view]")) {
    const selected = button.dataset.view === state.view;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  $("#calendar-view").hidden = !calendarMode;
  $("#calendar-selection").hidden = true;
  $("#calendar-selection").replaceChildren();
  $("#results-count").textContent = calendarMode && state.month ? `${state.month.slice(0, 4)} 年 ${Number(state.month.slice(5))} 月 · 同一地区、同一票种每日最低价` : `共 ${dates.length} 个日期${state.date ? "" : state.month ? ` · ${state.month.slice(0, 4)} 年 ${Number(state.month.slice(5))} 月` : ""}`;
  const list = $("#daily-list");
  list.hidden = false;
  if (calendarMode) {
    renderCalendar();
    if (!state.date || state.type === "other") {
      list.hidden = true;
      list.replaceChildren();
      return;
    }
    const selection = $("#calendar-selection");
    const heading = element("h3", "", `${state.date} · 当天渠道报价`);
    heading.tabIndex = -1;
    const clear = element("button", "calendar-clear", "清除日期");
    clear.type = "button";
    clear.addEventListener("click", () => { state.date = ""; render(); });
    selection.append(heading, clear);
    selection.hidden = false;
  }
  if (!dates.length) {
    const empty = element("div", "empty-state");
    empty.append(element("strong", "", "当前筛选下暂无报价"), element("p", "", "可切换旅游地区、票种或日期，也可手动刷新获取最新报价。"));
    if (scopedProducts().some((product) => groupFor(product) === "other")) empty.append(settingsButton(undefined, "查看待设置渠道"));
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

async function exportExcel() {
  const button = $("#excel-export-button");
  if (button.disabled) return;
  const feedback = $("#excel-export-feedback");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const showMessage = (message, isError = false) => {
    feedback.textContent = message;
    feedback.hidden = false;
    feedback.classList.toggle("is-error", isError);
    feedback.setAttribute("role", isError ? "alert" : "status");
  };
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "导出中…";
  showMessage("正在生成全部已保存数据的 Excel…");
  try {
    const response = await fetch("/api/export.xlsx", { cache: "no-store", signal: controller.signal });
    if (!response.ok) {
      let message = "暂时无法导出，请稍后重试。";
      try { const result = await response.json(); message = result.error || result.message || message; } catch { /* 保留可读的错误提示。 */ }
      throw new Error(message);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!/application\/(?:vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|octet-stream)/i.test(contentType)) throw new Error("返回的文件格式不正确，请稍后重试。");
    const file = await response.blob();
    if (!file.size) throw new Error("返回的文件为空，请稍后重试。");
    const disposition = response.headers.get("content-disposition") || "";
    let filename = "渠道每日最低价.xlsx";
    const encodedFilename = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
    const plainFilename = disposition.match(/filename\s*=\s*"([^"]+)"/i)?.[1];
    try { const candidate = encodedFilename ? decodeURIComponent(encodedFilename.trim()) : plainFilename; if (candidate && /\.xlsx$/i.test(candidate)) filename = candidate.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_"); } catch { /* 非法文件名使用默认名称。 */ }
    const url = URL.createObjectURL(file);
    const link = element("a");
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    // 让浏览器或桌面端的保存对话框先接管数据，再释放临时文件地址。
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    showMessage("已发起下载，请保存 Excel 文件。");
  } catch (error) {
    showMessage(error.name === "AbortError" ? "导出超时，请稍后重试。" : `导出失败：${error.message}`, true);
  } finally {
    clearTimeout(timeout);
    button.disabled = false;
    button.setAttribute("aria-busy", "false");
    button.textContent = "导出 Excel";
  }
}

$("#destination-filter").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-destination]");
  if (!button || !event.currentTarget.contains(button)) return;
  state.destination = button.dataset.destination;
  render();
});
$("#month-filter").addEventListener("change", (event) => { state.month = event.target.value; state.date = ""; render(); });
$("#date-filter").addEventListener("change", (event) => { state.date = event.target.value; render(); });
for (const button of document.querySelectorAll("[data-type]")) button.addEventListener("click", () => {
  state.type = button.dataset.type;
  for (const item of document.querySelectorAll("[data-type]")) { const active = item === button; item.classList.toggle("active", active); item.setAttribute("aria-pressed", String(active)); }
  render();
});
$("#refresh-button").addEventListener("click", refreshPrices);
$("#excel-export-button").addEventListener("click", exportExcel);
$("#view-mode").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (!button || !event.currentTarget.contains(button)) return;
  state.view = button.dataset.view;
  render();
});
window.addEventListener("ticket-types-saved", () => { void loadPrices(); });
enhanceFilterSelect($("#month-filter"));
enhanceFilterSelect($("#date-filter"));
void loadPrices();
void pollRefresh();
