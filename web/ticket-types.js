"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const button = byId("ticket-types-button");
  const dialog = byId("ticket-types-dialog");
  const form = byId("ticket-types-form");
  const search = byId("ticket-types-search");
  const list = byId("ticket-types-list");
  const feedback = byId("ticket-types-feedback");
  const save = byId("ticket-types-save");
  const cancel = byId("ticket-types-cancel");
  const close = byId("ticket-types-close");
  const retry = byId("ticket-types-retry");
  const groupNames = { adult: "成人票", children: "儿童票", other: "其他票种" };
  let products = [];
  let baseline = new Map();
  let draft = new Map();
  let ready = false;
  let loading = false;
  let saving = false;
  let revision = 0;

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
    for (const radio of list.querySelectorAll('input[type="radio"]')) radio.disabled = saving;
    form.setAttribute("aria-busy", String(loading || saving));
    byId("ticket-types-pending").textContent = changed ? `${changed} 个渠道待保存` : ready && products.length ? "保存后立即生效" : "";
  }

  function renderStatus(product, target) {
    const value = draft.get(String(product.goodsId));
    target.textContent = value ? `本地设为${groupNames[value]}` : "跟随接口";
    target.classList.toggle("is-remote", !value);
  }

  function renderList() {
    const keyword = search.value.trim().toLocaleLowerCase();
    const filtered = products.filter((product) => `${product.name} ${product.goodsId}`.toLocaleLowerCase().includes(keyword));
    byId("ticket-types-count").textContent = keyword ? `${filtered.length} / ${products.length} 个渠道` : `${products.length} 个渠道`;
    if (!filtered.length) {
      list.replaceChildren(node("div", "ticket-types-empty", products.length ? "没有找到匹配的渠道，请换个名称或编号。" : "还没有已采集的渠道，请先关闭此窗口并手动刷新价格。"));
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
      const sourceName = groupNames[product.sourceGroup] || "其他票种";
      meta.append(node("span", "", `接口票种：${sourceName}（${product.sourceTicketType || "UNKNOWN"}）`));
      const local = node("span", "ticket-type-local");
      renderStatus(product, local);
      meta.append(local);
      const choice = node("div", "ticket-type-choice");
      for (const [value, label] of [["", "跟随接口"], ["adult", "成人票"], ["children", "儿童票"]]) {
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
          syncControls();
        });
        option.append(input, node("span", "", label));
        choice.append(option);
      }
      row.append(meta, choice);
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
      return [id, value === "adult" || value === "children" ? value : null];
    }));
    draft = new Map(baseline);
    ready = true;
  }

  async function load() {
    const current = ++revision;
    ready = false;
    loading = true;
    products = [];
    baseline = new Map();
    draft = new Map();
    search.value = "";
    retry.hidden = true;
    cancel.textContent = "取消";
    list.replaceChildren(node("div", "ticket-types-empty", "正在读取渠道票种…"));
    byId("ticket-types-count").textContent = "";
    showMessage("");
    syncControls();
    try {
      const result = await request();
      if (current !== revision || !dialog.open) return;
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
  close.addEventListener("click", closeDialog);
  cancel.addEventListener("click", closeDialog);
  retry.addEventListener("click", () => void load());
  search.addEventListener("input", renderList);
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
