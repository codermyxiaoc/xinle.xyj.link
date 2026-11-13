"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const button = byId("ticket-types-button");
  const dialog = byId("ticket-types-dialog");
  const form = byId("ticket-types-form");
  const search = byId("ticket-types-search");
  const destinationFilter = byId("ticket-types-destination-filter");
  const list = byId("ticket-types-list");
  const feedback = byId("ticket-types-feedback");
  const save = byId("ticket-types-save");
  const cancel = byId("ticket-types-cancel");
  const close = byId("ticket-types-close");
  const retry = byId("ticket-types-retry");
  const groupNames = { adult_1d: "1日成人", children_1d: "1日儿童", adult_1_5d: "1.5日成人", children_1_5d: "1.5日儿童", other: "待设置" };
  const localGroups = Object.keys(groupNames).filter((group) => group !== "other");
  let products = [];
  let baseline = new Map();
  let draft = new Map();
  let ready = false;
  let loading = false;
  let saving = false;
  let revision = 0;
  let destination = null;

  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = String(text);
    return result;
  }

  function showMessage(message, kind = "") {
    feedback.textContent = message;
    feedback.hidden = !message;
    feedback.classList.toggle("is-error", kind === "error");
    feedback.classList.toggle("is-success", kind === "success");
    feedback.setAttribute("role", kind === "error" ? "alert" : "status");
  }

  function changes() {
    return Object.fromEntries([...draft].filter(([id, value]) => baseline.get(id) !== value));
  }

  function syncControls() {
    const changed = Object.keys(changes()).length;
    save.disabled = !ready || saving || changed === 0;
    save.textContent = saving ? "正在保存…" : "保存设置";
    cancel.disabled = saving;
    close.disabled = saving;
    retry.disabled = saving;
    search.disabled = !ready || saving;
    for (const option of destinationFilter.querySelectorAll("button")) option.disabled = !ready || saving;
    for (const radio of list.querySelectorAll('input[type="radio"]')) radio.disabled = saving;
    form.setAttribute("aria-busy", String(loading || saving));
    byId("ticket-types-pending").textContent = changed ? `${changed} 个渠道待保存` : ready && products.length ? "保存后立即生效" : "";
  }

  function renderStatus(product, target) {
    const value = draft.get(String(product.goodsId));
    target.textContent = value ? `本地设为${groupNames[value]}` : "跟随接口";
    target.classList.toggle("is-remote", !value);
  }

  function destinationFor(product) {
    const name = product.destinationName || product.spotName || "未标注地区";
    const key = product.destinationKey || (product.spotId != null ? `spot:${product.spotId}` : product.spotName ? `name:${product.spotName}` : "unknown");
    return { key, name };
  }

  function renderDestinations() {
    const places = [...new Map(products.map((product) => {
      const place = destinationFor(product);
      return [place.key, place];
    })).values()];
    if (destination === null || (destination && !places.some((place) => place.key === destination))) {
      destination = places.find((place) => place.name === "北京环球度假区")?.key ?? "";
    }
    destinationFilter.replaceChildren(...[{ key: "", name: "全部地区" }, ...places].map((place) => {
      const selected = place.key === destination;
      const option = node("button", selected ? "active" : "", place.name);
      option.type = "button";
      option.dataset.destination = place.key;
      option.setAttribute("aria-pressed", String(selected));
      return option;
    }));
  }

  function filteredProducts() {
    const keyword = search.value.trim().toLocaleLowerCase();
    return products.filter((product) => (!destination || destinationFor(product).key === destination) &&
      `${product.name} ${product.goodsId} ${destinationFor(product).name} ${groupNames[draft.get(String(product.goodsId)) || product.sourceGroup] || "待设置"}`.toLocaleLowerCase().includes(keyword));
  }

  function renderCount(filtered = filteredProducts()) {
    const pending = filtered.filter((product) => !draft.get(String(product.goodsId)) && (!product.sourceGroup || product.sourceGroup === "other")).length;
    const scopedCount = products.filter((product) => !destination || destinationFor(product).key === destination).length;
    byId("ticket-types-count").textContent = `${search.value.trim() ? `${filtered.length} / ${scopedCount}` : scopedCount} 个渠道 · ${pending} 个待设置`;
  }

  function renderList() {
    const filtered = filteredProducts();
    renderCount(filtered);
    if (!filtered.length) {
      list.replaceChildren(node("div", "ticket-types-empty", products.length ? "没有找到匹配的渠道，请换个名称、编号或地区。" : "还没有已采集的渠道，请先关闭此窗口并手动刷新价格。"));
      syncControls();
      return;
    }
    list.replaceChildren(...filtered.map((product) => {
      const id = String(product.goodsId);
      const row = node("fieldset", "ticket-type-row");
      row.dataset.goodsId = id;
      const title = product.name.endsWith(`-${id}`) ? product.name : `${product.name}-${id}`;
      row.append(node("legend", "", title));
      const meta = node("div", "ticket-type-meta");
      const sourceName = groupNames[product.sourceGroup] || "待设置";
      meta.append(node("span", "ticket-type-destination", `旅游地区：${product.destinationName || product.spotName || "未标注地区"}`));
      meta.append(node("span", "", `自动识别：${sourceName}（接口：${product.sourceTicketType || "UNKNOWN"}）`));
      const local = node("span", "ticket-type-local");
      renderStatus(product, local);
      meta.append(local);
      const choice = node("div", "ticket-type-choice");
      for (const [value, label] of [["", "跟随接口"], ...localGroups.map((group) => [group, groupNames[group]])]) {
        const option = node("label", "ticket-type-option");
        const input = node("input");
        input.type = "radio";
        input.name = `ticket-type-${id}`;
        input.value = value;
        input.checked = (draft.get(id) || "") === value;
        input.addEventListener("change", () => {
          if (!input.checked || saving) return;
          draft.set(id, input.value || null);
          renderStatus(product, local);
          cancel.textContent = "取消";
          showMessage("");
          renderCount();
          syncControls();
        });
        option.append(input, node("span", "", label));
        choice.append(option);
      }
      row.append(meta, choice);
      if (sourceName === "待设置") row.append(node("p", "ticket-type-needs-setting", `${product.classificationReason || "游玩时长或适用人群未能确认"}。请核对产品后选择票种；保留「跟随接口」时将显示在待设置渠道中。`));
      return row;
    }));
    syncControls();
  }

  async function request(options) {
    const response = await fetch("/api/ticket-types", { cache: "no-store", ...options });
    let result;
    try { result = await response.json(); }
    catch { throw new Error("票种设置服务暂时不可用，请稍后重试。"); }
    if (!response.ok) throw new Error(result.error || result.message || "操作未完成，请重试。");
    if (!result || !Array.isArray(result.products) || !result.overrides || typeof result.overrides !== "object") throw new Error("票种配置格式不正确，请重新读取。");
    if (result.products.some((product) => !Number.isSafeInteger(Number(product.goodsId)) || typeof product.name !== "string")) throw new Error("渠道信息格式不正确，请重新读取。");
    return result;
  }

  function accept(result) {
    products = result.products;
    baseline = new Map(products.map((product) => {
      const id = String(product.goodsId);
      const value = product.override ?? result.overrides[id] ?? null;
      return [id, localGroups.includes(value) ? value : null];
    }));
    draft = new Map(baseline);
    ready = true;
    renderDestinations();
  }

  async function load(keyword = "", goodsId, initialDestination = byId("destination-filter")?.querySelector('button[aria-pressed="true"]')?.dataset.destination ?? null) {
    const current = ++revision;
    ready = false;
    loading = true;
    products = [];
    baseline = new Map();
    draft = new Map();
    destination = initialDestination;
    destinationFilter.replaceChildren();
    search.value = keyword;
    retry.hidden = true;
    cancel.textContent = "取消";
    list.replaceChildren(node("div", "ticket-types-empty", "正在读取渠道票种…"));
    byId("ticket-types-count").textContent = "";
    showMessage("");
    syncControls();
    try {
      const result = await request();
      if (current !== revision || !dialog.open) return;
      const target = goodsId === undefined ? null : result.products.find((product) => String(product.goodsId) === String(goodsId));
      if (target) destination = destinationFor(target).key;
      accept(result);
      loading = false;
      renderList();
      if (products.length) search.focus();
    } catch (error) {
      if (current !== revision || !dialog.open) return;
      loading = false;
      list.replaceChildren();
      showMessage(`读取票种失败：${error.message}`, "error");
      retry.hidden = false;
      syncControls();
    }
  }

  function closeDialog() { if (!saving) dialog.close(); }
  button.addEventListener("click", () => { if (!dialog.open) { dialog.showModal(); void load(); } });
  window.addEventListener("open-ticket-types", (event) => {
    if (dialog.open) return;
    dialog.showModal();
    void load(event.detail?.goodsId === undefined ? "待设置" : String(event.detail.goodsId), event.detail?.goodsId);
  });
  close.addEventListener("click", closeDialog);
  cancel.addEventListener("click", closeDialog);
  retry.addEventListener("click", () => void load(search.value, undefined, destination));
  search.addEventListener("input", renderList);
  destinationFilter.addEventListener("click", (event) => {
    const option = event.target.closest("button[data-destination]");
    if (!ready || saving || !option || !destinationFilter.contains(option)) return;
    destination = option.dataset.destination;
    for (const item of destinationFilter.querySelectorAll("button")) {
      const selected = item === option;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-pressed", String(selected));
    }
    renderList();
    list.scrollTop = 0;
  });
  dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog();
  });
  dialog.addEventListener("close", () => {
    revision++;
    ready = false;
    loading = false;
    products = [];
    baseline.clear();
    draft.clear();
    destination = null;
    destinationFilter.replaceChildren();
    list.replaceChildren();
    showMessage("");
    button.focus({ preventScroll: true });
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!ready || saving || !Object.keys(changes()).length) return;
    const overrides = changes();
    saving = true;
    showMessage("");
    syncControls();
    try {
      const result = await request({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ overrides }) });
      accept(result);
      renderList();
      cancel.textContent = "完成";
      showMessage("票种设置已保存。比价页面会立即更新，再次刷新价格会保留本地设置。", "success");
      window.dispatchEvent(new CustomEvent("ticket-types-saved"));
    } catch (error) {
      showMessage(`保存失败：${error.message}`, "error");
    } finally {
      saving = false;
      syncControls();
    }
  });
})();
