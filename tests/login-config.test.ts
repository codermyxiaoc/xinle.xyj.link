import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readLoginCredentials, getLoginConfigMetadata, saveLoginConfig } from "../lib/login-config.ts";
import { createDashboardServer } from "../server.ts";

async function directory(t: any) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xinle-login-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("兼容原配置，网页保存后下次读取立即使用新账号，旧环境值不能覆盖", async (t) => {
  const dir = await directory(t);
  await writeFile(path.join(dir, ".env.local"), "XINLE_USERNAME=legacy\nXINLE_PASSWORD=legacy-secret\n");
  assert.deepEqual(readLoginCredentials(dir, {}), { username: "legacy", password: "legacy-secret" });
  const password = '空 格#=\\"特殊字符';
  await saveLoginConfig({ username: "updated-account", password }, dir);
  assert.deepEqual(readLoginCredentials(dir, { XINLE_USERNAME: "old", XINLE_PASSWORD: "old" }), { username: "updated-account", password });
  assert.deepEqual(getLoginConfigMetadata(dir), { username: "updated-account", hasPassword: true });
  await saveLoginConfig({ username: "next-account", password: "" }, dir);
  assert.deepEqual(readLoginCredentials(dir), { username: "next-account", password });
  assert.deepEqual(await readdir(path.join(dir, "config")), ["login.json"]);
});

test("无效输入不覆盖旧配置，首次配置不能缺少密码", async (t) => {
  const dir = await directory(t);
  await assert.rejects(saveLoginConfig({ username: "new", password: "" }, dir));
  await saveLoginConfig({ username: "valid", password: "secret" }, dir);
  const previous = await readFile(path.join(dir, "config/login.json"), "utf8");
  for (const input of [{ username: "", password: "secret" }, { username: "valid", password: "bad\npassword" }, { username: "valid", password: 123 }]) {
    await assert.rejects(saveLoginConfig(input, dir));
    assert.equal(await readFile(path.join(dir, "config/login.json"), "utf8"), previous);
  }
});

test("配置API保存后读取不回传密码，不暴露文件或接受跨站更新", async (t) => {
  const dir = await directory(t);
  const server = createDashboardServer({ configRoot: dir, outputDir: dir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const response = await fetch(base + "/api/login-config", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ username: "api-account", password: "do-not-return-this" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes("do-not-return-this"), false);
  assert.deepEqual(await (await fetch(base + "/api/login-config")).json(), { username: "api-account", hasPassword: true });
  assert.equal((await fetch(base + "/config/login.json")).status, 404);
  assert.equal((await fetch(base + "/api/login-config", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.com" }, body: "{}" })).status, 403);
  assert.equal(readLoginCredentials(dir).username, "api-account");
});
