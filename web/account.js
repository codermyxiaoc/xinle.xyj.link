"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const dialog = byId("login-config-dialog");
  const form = byId("login-config-form");
  const username = byId("login-config-username");
  const password = byId("login-config-password");
  const save = byId("login-config-save");
  const cancel = byId("login-config-cancel");
  const close = byId("login-config-close");
  const toggle = byId("login-config-password-toggle");
  const feedback = byId("login-config-feedback");
  const retry = byId("login-config-retry");
  let hasPassword = false;
  let ready = false;
  let loading = false;
  let saving = false;
  let revision = 0;

  function showMessage(message, kind = "") {
    feedback.textContent = message;
    feedback.hidden = !message;
    feedback.classList.toggle("is-error", kind === "error");
    feedback.classList.toggle("is-success", kind === "success");
    feedback.setAttribute("role", kind === "error" ? "alert" : "status");
  }

  function resetPassword() {
    password.value = "";
    password.type = "password";
    toggle.textContent = "显示";
    toggle.setAttribute("aria-label", "显示密码");
    toggle.setAttribute("aria-pressed", "false");
  }

  function syncControls() {
    username.disabled = !ready || saving;
    password.disabled = !ready || saving;
    toggle.disabled = !ready || saving;
    save.disabled = !ready || saving;
    cancel.disabled = saving;
    close.disabled = saving;
    retry.disabled = saving;
    save.textContent = saving ? "正在保存…" : "保存配置";
    password.required = !hasPassword;
    password.placeholder = hasPassword ? "留空则保留当前密码" : "请输入登录密码";
    byId("login-config-password-hint").textContent = hasPassword
      ? "已保存密码，不会回显。需要更换时输入新密码，留空可保留。"
      : "请输入与该账号对应的登录密码。";
    form.setAttribute("aria-busy", String(saving || loading));
  }

  async function requestConfig(options) {
    const response = await fetch("/api/login-config", { cache: "no-store", ...options });
    let result;
    try { result = await response.json(); }
    catch { throw new Error("配置服务暂时不可用，请稍后重试。"); }
    if (!response.ok) throw new Error(result.error || result.message || "配置操作未完成，请重试。");
    return result;
  }

  async function loadConfig() {
    const current = ++revision;
    ready = false;
    loading = true;
    hasPassword = false;
    username.value = "";
    resetPassword();
    cancel.textContent = "取消";
    retry.hidden = true;
    showMessage("正在读取当前登录配置…");
    syncControls();
    try {
      const result = await requestConfig();
      if (current !== revision || !dialog.open) return;
      if (typeof result.username !== "string" || typeof result.hasPassword !== "boolean") {
        throw new Error("读取的配置格式不正确，请重试。");
      }
      username.value = result.username;
      hasPassword = result.hasPassword;
      ready = true;
      loading = false;
      showMessage("");
      syncControls();
      username.focus();
    } catch (error) {
      if (current !== revision || !dialog.open) return;
      ready = false;
      loading = false;
      showMessage(`读取配置失败：${error.message}`, "error");
      retry.hidden = false;
      syncControls();
    }
  }

  function closeDialog() {
    if (!saving) dialog.close();
  }

  byId("login-config-button").addEventListener("click", () => {
    if (dialog.open) return;
    dialog.showModal();
    void loadConfig();
  });
  cancel.addEventListener("click", closeDialog);
  close.addEventListener("click", closeDialog);
  retry.addEventListener("click", () => { void loadConfig(); });
  dialog.addEventListener("cancel", (event) => {
    if (saving) event.preventDefault();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeDialog();
  });
  dialog.addEventListener("close", () => {
    revision++;
    ready = false;
    loading = false;
    resetPassword();
    showMessage("");
    byId("login-config-button").focus();
  });
  toggle.addEventListener("click", () => {
    const show = password.type === "password";
    password.type = show ? "text" : "password";
    toggle.textContent = show ? "隐藏" : "显示";
    toggle.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
    toggle.setAttribute("aria-pressed", String(show));
  });
  form.addEventListener("input", () => {
    if (ready && !saving) { showMessage(""); cancel.textContent = "取消"; }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!ready || saving) return;
    username.value = username.value.trim();
    if (!form.reportValidity()) return;
    saving = true;
    retry.hidden = true;
    showMessage("");
    syncControls();
    try {
      const result = await requestConfig({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.value, password: password.value }),
      });
      if (typeof result.username !== "string" || result.hasPassword !== true) {
        throw new Error("保存结果尚未确认，请重新读取配置后核对。");
      }
      username.value = result.username;
      hasPassword = true;
      resetPassword();
      cancel.textContent = "完成";
      showMessage("登录配置已保存。新配置从下一次刷新开始生效。", "success");
    } catch (error) {
      showMessage(`保存失败：${error.message}`, "error");
    } finally {
      saving = false;
      syncControls();
    }
  });
})();
