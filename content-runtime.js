/* 儿童成长小草园：公共内容运行时。个人数据永不在此模块读写。 */
(function () {
  "use strict";
  const DB = "cgg-public-content-v1", STORE = "snapshots", ACTIVE = "active";
  const SETTINGS = "cgg-update-settings-v1";
  const DEFAULT_MANIFEST = "https://raw.githubusercontent.com/YOUR_GITHUB_USER/YOUR_REPOSITORY/main/updates/manifest.json";
  const baseUrl = new URL("data/knowledge.json", document.baseURI).href;
  const originalFetch = window.fetch.bind(window);
  let activeContent, lastRemote, readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });

  function db() { return new Promise((resolve, reject) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
  async function get(key) { const d = await db(); return new Promise((resolve, reject) => { const r = d.transaction(STORE).objectStore(STORE).get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
  async function put(key, value) { const d = await db(); return new Promise((resolve, reject) => { const r = d.transaction(STORE, "readwrite").objectStore(STORE).put(value, key); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); }); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function settings() { try { return { manifestUrl: DEFAULT_MANIFEST, autoCheck: false, ...JSON.parse(localStorage.getItem(SETTINGS) || "{}") }; } catch { return { manifestUrl: DEFAULT_MANIFEST, autoCheck: false }; } }
  function saveSettings(next) { localStorage.setItem(SETTINGS, JSON.stringify(next)); }
  function version(content) { return content && (content.knowledgeVersion || content.contentVersion) || "未知"; }
  function validate(content) {
    if (!content || !Array.isArray(content.entries) || !Array.isArray(content.books)) throw new Error("内容结构不完整");
    const ids = new Set(), sequences = new Set();
    for (const entry of content.entries) { if (!entry || !entry.id || ids.has(entry.id)) throw new Error("文章编号重复或缺失：" + (entry && entry.id || "未知")); if (entry.sequence != null && sequences.has(entry.sequence)) throw new Error("知识序号重复：" + entry.sequence); ids.add(entry.id); if (entry.sequence != null) sequences.add(entry.sequence); }
    const bookIds = new Set();
    for (const book of content.books) { if (!book || !book.id || bookIds.has(book.id)) throw new Error("书籍编号重复或缺失：" + (book && book.id || "未知")); bookIds.add(book.id); }
    content.entryCount = content.entries.length;
    return content;
  }
  async function digest(text) { const bytes = new TextEncoder().encode(text); const hash = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join(""); }
  function removeById(items, id) { const index = items.findIndex(item => item.id === id); if (index >= 0) items.splice(index, 1); return index >= 0; }
  function upsert(items, item, required) { const index = items.findIndex(x => x.id === item.id); if (required && index < 0) throw new Error("找不到要更新的编号：" + item.id); if (index < 0) items.push(item); else items[index] = { ...items[index], ...item }; }
  function operationsFor(pack) { return pack.operations || { entries: pack.entries, books: pack.books, retire: pack.retire, aliases: pack.aliases, migrations: pack.migrations }; }
  function applyPackage(current, pack) {
    if (!pack || pack.schemaVersion !== "1.0") throw new Error("不支持的更新包格式");
    if (pack.fromVersion && pack.fromVersion !== version(current)) throw new Error("更新包不适用于当前内容版本");
    const next = clone(current), ops = operationsFor(pack), entryOps = ops.entries || {}, bookOps = ops.books || {};
    (entryOps.add || []).forEach(x => { if (next.entries.some(y => y.id === x.id)) throw new Error("新增文章编号已存在：" + x.id); next.entries.push(x); });
    (entryOps.update || []).forEach(x => upsert(next.entries, x, true));
    (bookOps.add || []).forEach(x => { if (next.books.some(y => y.id === x.id)) throw new Error("新增书籍编号已存在：" + x.id); next.books.push(x); });
    (bookOps.update || []).forEach(x => upsert(next.books, x, true));
    const retired = ops.retire || {};
    [...(entryOps.retire || []), ...(retired.entries || [])].forEach(x => removeById(next.entries, typeof x === "string" ? x : x.id));
    [...(bookOps.retire || []), ...(retired.books || [])].forEach(x => removeById(next.books, typeof x === "string" ? x : x.id));
    next.aliases = { ...(next.aliases || {}) };
    (ops.aliases || []).forEach(x => { if (!x.from || !x.to) throw new Error("alias 缺少 from/to"); next.aliases[x.from] = x.to; });
    (ops.migrations || []).forEach(m => {
      if (m.type === "rename-entry") { const item = next.entries.find(x => x.id === m.from); if (!item) throw new Error("迁移源文章不存在：" + m.from); if (next.entries.some(x => x.id === m.to)) throw new Error("迁移目标编号已存在：" + m.to); item.id = m.to; next.aliases[m.from] = m.to; }
      else if (m.type === "rename-book") { const item = next.books.find(x => x.id === m.from); if (!item) throw new Error("迁移源书籍不存在：" + m.from); if (next.books.some(x => x.id === m.to)) throw new Error("迁移目标书籍已存在：" + m.to); item.id = m.to; next.aliases[m.from] = m.to; }
      else if (m.type && m.type !== "metadata") throw new Error("不支持的迁移类型：" + m.type);
    });
    next.knowledgeVersion = pack.toVersion || pack.contentVersion || version(next);
    next.generatedAt = pack.updatedAt || new Date().toISOString().slice(0, 10);
    return validate(next);
  }
  function remoteUrl(url) { return new URL(url, document.baseURI).href; }
  async function check() {
    const s = settings(); if (!s.manifestUrl || s.manifestUrl.includes("YOUR_GITHUB_")) throw new Error("请先在更新中心填写你的 GitHub manifest 地址");
    const response = await originalFetch(remoteUrl(s.manifestUrl), { cache: "no-store" }); if (!response.ok) throw new Error("无法读取远端 manifest（" + response.status + "）");
    const manifest = await response.json(); if (manifest.schemaVersion !== "1.0" || !Array.isArray(manifest.updates)) throw new Error("远端 manifest 格式不正确");
    manifest._sourceUrl = remoteUrl(s.manifestUrl); lastRemote = manifest;
    const path = []; let cursor = version(activeContent), seen = new Set();
    while (cursor !== manifest.latestVersion) { const update = manifest.updates.find(x => x.fromVersion === cursor); if (!update || seen.has(update.id)) break; path.push(update); seen.add(update.id); cursor = update.toVersion; }
    return { manifest, path, available: path.length > 0 && cursor === manifest.latestVersion };
  }
  async function installAvailable() {
    const result = await check(); if (!result.available) throw new Error("没有适用于当前版本的完整更新链");
    const previous = clone(activeContent); let next = clone(activeContent);
    try {
      for (const item of result.path) {
        const response = await originalFetch(new URL(item.packageUrl, result.manifest._sourceUrl).href, { cache: "no-store" }); if (!response.ok) throw new Error("无法下载更新包：" + item.id);
        const text = await response.text(); if (item.sha256 && (await digest(text)).toLowerCase() !== item.sha256.toLowerCase()) throw new Error("更新包校验失败：" + item.id);
        next = applyPackage(next, JSON.parse(text));
      }
      await put("previous", previous); await put(ACTIVE, next); activeContent = next; localStorage.setItem("growth-garden-public-content", JSON.stringify(next));
      return { version: version(next), count: next.entries.length };
    } catch (error) { activeContent = previous; throw error; }
  }
  async function rollback() { const previous = await get("previous"); if (!previous) throw new Error("没有可回退的上一个内容版本"); validate(previous); const current = clone(activeContent); await put(ACTIVE, previous); await put("previous", current); activeContent = previous; localStorage.setItem("growth-garden-public-content", JSON.stringify(previous)); return version(previous); }
  function installFetchBridge() { window.fetch = async function (input, init) { const url = typeof input === "string" ? input : input && input.url; if (url && new URL(url, document.baseURI).href.split("?")[0] === baseUrl) return new Response(JSON.stringify(activeContent), { status: 200, headers: { "Content-Type": "application/json" } }); return originalFetch(input, init); }; }
  function center() {
    const style = document.createElement("style"); style.textContent = ".cgg-update-trigger{position:fixed;right:14px;bottom:76px;z-index:20;border:0;border-radius:999px;background:#356e42;color:#fff;padding:10px 13px;font:600 13px system-ui;box-shadow:0 3px 12px #0004}.cgg-update-dialog{position:fixed;inset:0;z-index:100;background:#0007;display:grid;place-items:end center;padding:0}.cgg-update-card{width:min(100%,520px);max-height:86vh;overflow:auto;background:#fffaf3;border-radius:22px 22px 0 0;padding:22px;color:#26352a;font:15px system-ui;box-sizing:border-box}.cgg-update-card h2{margin:0 0 12px}.cgg-update-card label,.cgg-update-card input{display:block;width:100%;box-sizing:border-box}.cgg-update-card input{margin:6px 0 13px;padding:10px;border:1px solid #b7c7b5;border-radius:9px}.cgg-update-card button{border:0;border-radius:9px;padding:10px 12px;margin:5px 6px 0 0;background:#356e42;color:white}.cgg-update-card button.secondary{background:#e5ede4;color:#29402e}.cgg-update-status{line-height:1.65;background:#f0f5ef;padding:10px;border-radius:9px;white-space:pre-line}"; document.head.append(style);
    const trigger = document.createElement("button"); trigger.className = "cgg-update-trigger"; trigger.textContent = "内容更新"; trigger.onclick = show; document.body.append(trigger);
    function show() { const overlay = document.createElement("div"); overlay.className = "cgg-update-dialog"; const s = settings(); overlay.innerHTML = `<section class="cgg-update-card" role="dialog" aria-modal="true"><h2>内容更新中心</h2><div class="cgg-update-status">当前内容版本：${version(activeContent)}\n文章：${activeContent.entries.length} 篇　书籍：${activeContent.books.length} 本\n远端最新版本：${lastRemote && lastRemote.latestVersion || "尚未检查"}</div><label>GitHub manifest 公共地址<input class="url" value="${s.manifestUrl}"></label><label><input class="auto" type="checkbox" ${s.autoCheck ? "checked" : ""}> 启动时自动检查（只提示，不自动安装）</label><div><button class="check">检查更新</button><button class="install" disabled>下载并应用更新</button><button class="rollback secondary">回退上次成功内容</button><button class="close secondary">关闭</button></div><p class="hint"></p></section>`; document.body.append(overlay); const status = overlay.querySelector(".cgg-update-status"), hint = overlay.querySelector(".hint"), install = overlay.querySelector(".install"); const persist = () => saveSettings({ manifestUrl: overlay.querySelector(".url").value.trim(), autoCheck: overlay.querySelector(".auto").checked }); overlay.querySelector(".url").onchange = persist; overlay.querySelector(".auto").onchange = persist; overlay.querySelector(".close").onclick = () => overlay.remove(); overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
      overlay.querySelector(".check").onclick = async () => { persist(); hint.textContent = "正在检查…"; try { const r = await check(); status.textContent = `当前内容版本：${version(activeContent)}\n远端最新版本：${r.manifest.latestVersion}\n${r.manifest.summary || ""}\n${r.available ? "可更新：" + r.path.map(x => x.summary || x.toVersion).join("；") : "当前已是最新，或远端缺少从当前版本开始的完整更新链。"}`; install.disabled = !r.available; hint.textContent = ""; } catch (e) { hint.textContent = "检查失败：" + e.message + "。现有离线内容仍可继续使用。"; } };
      install.onclick = async () => { hint.textContent = "正在下载、校验并合并…"; install.disabled = true; try { const r = await installAvailable(); hint.textContent = `已更新至 ${r.version}，共 ${r.count} 篇。页面将重新打开。`; setTimeout(() => location.reload(), 700); } catch (e) { hint.textContent = "更新未应用：" + e.message + "。已保留上一次成功内容。"; } };
      overlay.querySelector(".rollback").onclick = async () => { try { const v = await rollback(); hint.textContent = "已回退到 " + v + "，页面将重新打开。"; setTimeout(() => location.reload(), 700); } catch (e) { hint.textContent = e.message; } };
    }
  }
  async function start() { try { let current = await get(ACTIVE); if (!current) { const response = await originalFetch(baseUrl, { cache: "no-store" }); if (!response.ok) throw new Error("基础内容无法加载"); current = await response.json(); await put(ACTIVE, validate(current)); } activeContent = validate(current); localStorage.setItem("growth-garden-public-content", JSON.stringify(activeContent)); installFetchBridge(); readyResolve(); center(); if (settings().autoCheck && navigator.onLine) check().catch(() => {}); } catch (e) { console.error("内容运行时启动失败", e); readyResolve(); } }
  window.CGGContentRuntime = { ready, check, installAvailable, rollback, applyPackage, getStatus: () => ({ version: version(activeContent), entries: activeContent && activeContent.entries.length, remote: lastRemote && lastRemote.latestVersion }) };
  start();
}());
