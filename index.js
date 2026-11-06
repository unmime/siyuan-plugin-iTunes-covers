/**
 * iTunes Covers for SiYuan
 *
 * 用 Apple iTunes Search API 搜书 / 音乐专辑 / 剧集的官方封面，
 * 插入正文或设为文档图标。工程骨架与交互照抄 siyuan-plugin-LLM-icons。
 *
 * 以下机制均沿用 LLM-icons 已实机验证的结论（思源 3.8.9）：
 * - 图标值格式为 `<组名>/<文件名>`，内核通过 `/emojis/<组>/<文件>` 提供静态服务；
 * - 图标文件写入 `data/emojis/<组>/`（/api/file/putFile），会随工作区同步；
 * - 设图标走 `/api/attr/setBlockAttrs`，属性名 `icon`，之后需手动刷新界面；
 * - 正文插图上传 `/assets/<组>/`（/api/asset/upload），导出时才会被一起打包。
 *
 * 数据来源：Apple iTunes Search API（无需 key）。
 * 封面版权归各自权利人所有，仅供个人标识使用。
 */
const { Plugin, Dialog, Menu, showMessage, getAllEditor } = require("siyuan");

const PLUGIN_NAME = "siyuan-plugin-iTunes-covers";
// 组名与插件名对齐：T 大写，Linux 上大小写敏感，三处（目录 / name / 组名）必须一致
const EMOJI_GROUP = "iTunes-covers";
const ASSET_DIR = "iTunes-covers";
const SEARCH_API = "https://itunes.apple.com/search";

/**
 * chip → entity 映射。实测结论，不要改：
 * - 剧集必须用 tvSeason，tvShow 永远 0 条；
 * - movie 已被 Apple 停供，任何参数都返回 0 条；
 * - ebook 的标题在 trackName，专辑/剧集在 collectionName。
 */
const ENTITIES = [
    { id: "ebook",    labelKey: "typeBook",  nameKey: "trackName" },
    { id: "album",    labelKey: "typeAlbum", nameKey: "collectionName" },
    { id: "tvSeason", labelKey: "typeTv",    nameKey: "collectionName" },
];

/** artworkUrl100 的路径尾巴换成 3000：请求超过原图时返回原图，一次拿到最大 */
const COVER_SIZE = 3000;
/** 网格缩略图尺寸：104px 的卡片用 600 足够 retina，流量降 ~95%；插入 / 设图标仍用原图 */
const THUMB_SIZE = 600;

module.exports = class ItunesCovers extends Plugin {
    async onload() {
        // 资产上传会带时间戳后缀，重复插入会堆副本，这里按 trackId 缓存已上传路径
        this.assetCache = new Map();
        // 表情组里的图标文件按 trackId 缓存，避免重复下载 / putFile
        this.iconCache = new Map();
        // 封面原图按 trackId 缓存，设图标 + 插正文共用一次下载
        this.blobCache = new Map();

        this.addIcons(
            // 五角星，对齐插件图标（紫底玻璃星）
            `<symbol id="iconItcCovers" viewBox="0 0 32 32">
                <path d="M16 3.2 L19.2 12.4 L28.93 12.6 L21.17 18.48 L23.99 27.8 L16 22.24 L8.01 27.8 L10.83 18.48 L3.07 12.6 L12.8 12.4 Z"
                    fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
            </symbol>
            <symbol id="iconItcDoc" viewBox="0 0 32 32">
                <path d="M8.5 4h10.5l6 6v18a2 2 0 0 1-2 2H8.5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="2.2"/>
                <path d="M19 4v7h6" fill="none" stroke="currentColor" stroke-width="2.2"/>
            </symbol>`
        );

        this.addCommand({
            langKey: "openPicker",
            // 不设默认快捷键：入口已够多（顶栏 / 面包屑 / 标题图标菜单 / 命令面板），
            // 且默认键容易和 DevTools（⌥⌘I/J/C）或其他插件（如 LLM-icons 的 ⌥⌘Y）撞车。
            // 需要的用户可在 设置 → 快捷键 里自行绑定。
            callback: () => this.openPicker(),
        });

        this.addTopBar({
            icon: "iconItcCovers",
            title: this.i18n.topbarTitle,
            position: "right",
            callback: () => this.openPicker(),
        });

        // 面包屑按钮：主题把面包屑移到底部时，它就出现在那条胶囊里
        try {
            this.addBreadcrumbButton({
                id: "itunes-covers",
                icon: "iconItcCovers",
                title: this.i18n.topbarTitle,
                callback: (event, protyle) => {
                    if (event && event.preventDefault) event.preventDefault();
                    this.activeProtyle = protyle;
                    this.openPicker();
                },
            });
        } catch (err) {
            console.warn("[iTunes Covers] breadcrumb button failed", err);
        }

        // 表情面板里也放一个入口（面板头部的图标排）
        this.watchEmojiDialog();

        // 文档标题图标右键菜单入口
        this.eventBus.on("click-editortitleicon", (e) => {
            const d = e.detail;
            if (!d || !d.menu) return;
            d.menu.addItem({
                icon: "iconItcCovers",
                label: this.i18n.menuOpen,
                click: () => this.openPicker(d.data && d.data.id),
            });
        });
    }

    onunload() {
        if (this.emojiObserver) {
            this.emojiObserver.disconnect();
            this.emojiObserver = null;
        }
    }

    /* ── 数据：iTunes Search ─────────────────────── */

    /**
     * 搜 iTunes。group 为 "all" 时并发 3 个 entity 各 limit=12，
     * 单个 entity 用 limit=36。
     *
     * 用 Promise.allSettled：单个 entity 失败不能拖垮整体，
     * 成功的保留，全失败才抛错。
     * 每个请求 10s 超时兜底；传入 signal（新查询替换旧查询）会立即中断进行中的请求。
     */
    async searchItunes(term, group, signal) {
        const targets = group === "all" ? ENTITIES : ENTITIES.filter((e) => e.id === group);
        const limit = group === "all" ? 12 : 36;
        const settled = await Promise.allSettled(
            targets.map(async (e) => {
                // 中文关键词必须编码，直接拼进 URL 会请求失败
                const qs = new URLSearchParams({
                    term,
                    country: "us", // 实测 cn 的 ebook 返回 0 条
                    entity: e.id,
                    limit: String(limit),
                });
                const ac = new AbortController();
                const timer = setTimeout(() => ac.abort(new Error("timeout")), 10000);
                const relay = () => ac.abort(signal.reason);
                if (signal) {
                    if (signal.aborted) {
                        clearTimeout(timer);
                        throw signal.reason;
                    }
                    signal.addEventListener("abort", relay, { once: true });
                }
                try {
                    const resp = await fetch(`${SEARCH_API}?${qs}`, { signal: ac.signal });
                    if (!resp.ok) throw new Error("HTTP " + resp.status);
                    const data = await resp.json();
                    const label = this.i18n[e.labelKey];
                    return (data.results || [])
                        .filter((r) => r && r.artworkUrl100)
                        .map((r) => ({ ...r, __entity: e.id, __label: label, __nameKey: e.nameKey }));
                } finally {
                    clearTimeout(timer);
                    if (signal) signal.removeEventListener("abort", relay);
                }
            })
        );

        const ok = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
        if (!ok.length) {
            const reason = settled.find((s) => s.status === "rejected");
            throw (reason && reason.reason) || new Error("search failed");
        }
        // allSettled 保持输入顺序，flat 后即 ebook → album → tvSeason
        return ok.flat();
    }

    /** 展示标题：ebook 用 trackName，专辑 / 剧集用 collectionName，混用会得到 undefined */
    itemTitle(item) {
        const key = item.__nameKey || "trackName";
        return String(item[key] || item.collectionName || item.trackName || "cover");
    }

    /** 把 artworkUrl100 的 100x100bb 换成目标尺寸；超过原图时 Apple 返回原图，不报错 */
    coverUrl(item, size = COVER_SIZE) {
        return String(item.artworkUrl100 || "").replace(/\/\d+x\d+bb\./, `/${size}x${size}bb.`);
    }

    /** 安全文件名：去标点、限长 32 字符（沿用 appstore 插件的 safeFileName 思路） */
    safeName(item) {
        const title = this.itemTitle(item);
        return (title.replace(/[\\/:*?"<>|]/g, "").trim() || "cover").slice(0, 32);
    }

    /** 缓存键：trackId 全局唯一，没有就用标题兜底 */
    keyOf(item) {
        return String(item.trackId ?? this.itemTitle(item));
    }

    /** 图标 / 插图文件名，带 trackId 防止同名不同版的封面互相覆盖 */
    fileNameOf(item) {
        return `${this.safeName(item)}-${item.trackId ?? "cover"}.jpg`;
    }

    /** 下载封面原图（3000x3000bb），按 trackId 缓存，图标和插图共用一次网络请求 */
    async coverBlob(item) {
        const key = this.keyOf(item);
        if (this.blobCache.has(key)) return this.blobCache.get(key);
        const resp = await fetch(this.coverUrl(item));
        if (!resp.ok) throw new Error(`下载封面失败 (${resp.status})`);
        const blob = await resp.blob();
        this.blobCache.set(key, blob);
        return blob;
    }

    /* ── 图标文件（表情组）───────────────────────── */

    async readGroup() {
        try {
            const resp = await fetch("/api/file/readDir", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: `/data/emojis/${EMOJI_GROUP}` }),
            });
            const json = await resp.json();
            return json.code === 0 && Array.isArray(json.data) ? json.data : null;
        } catch {
            return null;
        }
    }

    async putEmojiFile(name, blob) {
        const form = new FormData();
        form.append("path", `/data/emojis/${EMOJI_GROUP}/${name}`);
        form.append("isDir", "false");
        form.append("modTime", String(Math.floor(Date.now() / 1000)));
        form.append("file", blob, name);
        const resp = await fetch("/api/file/putFile", { method: "POST", body: form });
        const json = await resp.json();
        if (json.code !== 0) throw new Error(json.msg || "putFile failed");
        return `${EMOJI_GROUP}/${name}`;
    }

    /** 需要时把远程封面写入工作区表情组，返回可直接用作图标的相对值 */
    async materialize(item) {
        const key = this.keyOf(item);
        if (this.iconCache.has(key)) return this.iconCache.get(key);

        const file = this.fileNameOf(item);
        const list = await this.readGroup(); // null 表示目录还不存在
        if (list && list.some((f) => !f.isDir && f.name === file)) {
            const cached = `${EMOJI_GROUP}/${file}`;
            this.iconCache.set(key, cached);
            return cached;
        }
        if (!list) {
            // 先写个占位文件把目录建出来
            await this.putEmojiFile(".keep", new Blob([""], { type: "text/plain" }));
        }
        const val = await this.putEmojiFile(file, await this.coverBlob(item));
        this.iconCache.set(key, val);
        return val;
    }

    /* ── 插入正文 ────────────────────────────────── */

    /** 把远程封面上传到 assets，返回 /assets/ 路径（正文插图用这个，导出后才不会丢） */
    async ensureAsset(item) {
        const key = this.keyOf(item);
        if (this.assetCache.has(key)) return this.assetCache.get(key);

        const file = this.fileNameOf(item);
        const blob = await this.coverBlob(item);

        const form = new FormData();
        form.append("assetsDirPath", `/assets/${ASSET_DIR}/`); // 结尾斜杠必须，否则上传失败
        form.append("file[]", blob, file);

        const up = await fetch("/api/asset/upload", { method: "POST", body: form });
        const json = await up.json();
        if (json.code !== 0) throw new Error(json.msg || "upload failed");

        const succ = (json.data && json.data.succMap) || {};
        const raw = succ[file] || Object.values(succ)[0];
        if (!raw) throw new Error("upload 未返回路径");
        const path = raw.charAt(0) === "/" ? raw : "/" + raw;
        this.assetCache.set(key, path);
        return path;
    }

    /** 收集所有可用的 protyle 实例（含隐藏标签页，按活跃度排序） */
    collectProtyles() {
        const list = [];
        const push = (p) => {
            if (p && typeof p.insert === "function" && list.indexOf(p) === -1) list.push(p);
        };
        const visible = (p) => p && p.element && !p.element.classList.contains("fn__none");

        const active = this.protyleOf(this.activeDocId());
        if (active) push(active);

        (getAllEditor() || []).forEach((e) => push(e && e.protyle));

        // 可见的排前面，避免插进后台标签页
        return list.sort((a, b) => (visible(b) ? 1 : 0) - (visible(a) ? 1 : 0));
    }

    /** 当前光标所在块，供 API 兜底定位 */
    currentBlockContext() {
        const sel = window.getSelection();
        let node = sel && sel.anchorNode;
        let el = null;
        while (node) {
            if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute("data-node-id")) {
                el = node;
                break;
            }
            node = node.parentNode;
        }
        if (!el) return null;
        const parent = el.parentElement && el.parentElement.closest("[data-node-id]");
        return {
            id: el.getAttribute("data-node-id"),
            parentId: parent ? parent.getAttribute("data-node-id") : "",
        };
    }

    /** 优先用 protyle 直接插入，失败则走 /api/block/insertBlock */
    async insertToBody(item) {
        const src = await this.ensureAsset(item);
        const alt = String(this.itemTitle(item)).replace(/[[\]()]/g, " ").trim();
        const html = `<img src="${this.esc(src)}" alt="${this.esc(alt)}">`;

        for (const protyle of this.collectProtyles()) {
            const wysiwyg = protyle && protyle.wysiwyg && protyle.wysiwyg.element;
            if (!wysiwyg || !wysiwyg.isConnected) continue;
            const before = wysiwyg.querySelectorAll("img").length;
            try {
                if (typeof protyle.focus === "function") protyle.focus();
                protyle.insert(html, false);
            } catch {
                continue;
            }
            // 确认真的插进去了，否则换下一个编辑器
            if (wysiwyg.querySelectorAll("img").length > before) return true;
        }
        return this.insertViaApi(src, alt);
    }

    async insertViaApi(src, alt) {
        const ctx = this.savedBlockCtx || this.currentBlockContext();
        let docId = this.activeDocId();
        if (!docId && ctx && ctx.id) docId = ctx.id;
        if (!docId) return false;

        const parentId = (ctx && ctx.parentId) || docId;
        const payload = {
            dataType: "markdown",
            data: `![${alt}](${src})`,
            parentID: parentId,
        };
        if (ctx && ctx.id && ctx.id !== parentId) payload.previousID = ctx.id;

        try {
            const resp = await fetch("/api/block/insertBlock", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const json = await resp.json();
            return json.code === 0;
        } catch {
            return false;
        }
    }

    /* ── 应用图标 ────────────────────────────────── */

    async applyIcon(blockId, item) {
        if (!blockId) {
            showMessage(this.i18n.noBlock);
            return false;
        }
        try {
            const iconValue = await this.materialize(item);
            const resp = await fetch("/api/attr/setBlockAttrs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: blockId, attrs: { icon: iconValue } }),
            });
            const json = await resp.json();
            if (json.code !== 0) throw new Error(json.msg || "setBlockAttrs failed");

            // 数据已写入，但界面不会自动更新，需手动刷新标题图标
            this.refreshTitleIcon(blockId, iconValue);

            showMessage(this.i18n.applied, 2000, "info");
            return true;
        } catch (err) {
            console.error("[iTunes Covers]", err);
            showMessage(`${this.i18n.applyFailed}: ${err.message}`);
            return false;
        }
    }

    /**
     * 当前激活文档的 id。
     *
     * 不能用 `.protyle-title[data-node-id]`：思源的标题元素模板里没有这个属性，
     * 选择器永远为空，导致点图标没反应。
     * 正确做法是走 getAllEditor() 拿 protyle 实例，读 block.rootID。
     */
    activeDocId() {
        // 从编辑器工具栏 / 面包屑进来时带了 protyle。必须确认它仍然可见——
        // 否则切过标签页后从顶栏开面板，会把图标设到上一个文档
        const ap = this.activeProtyle;
        if (
            ap && ap.block && ap.element && ap.element.isConnected &&
            !ap.element.classList.contains("fn__none")
        ) {
            return ap.block.rootID || "";
        }
        const list = typeof getAllEditor === "function" ? getAllEditor() : [];
        const editors = list.filter((e) => e && e.protyle && e.protyle.block);

        // 优先：可见且包含当前焦点的编辑器
        const active = document.activeElement;
        if (active) {
            const hit = editors.find(
                (e) =>
                    !e.protyle.element.classList.contains("fn__none") &&
                    e.protyle.element.contains(active)
            );
            if (hit) return hit.protyle.block.rootID || "";
        }

        // 其次：任何可见的编辑器（排除 fn__none 的后台标签页）
        const visible = editors.find(
            (e) => !e.protyle.element.classList.contains("fn__none")
        );
        if (visible) return visible.protyle.block.rootID || "";

        return editors[0]?.protyle.block.rootID || "";
    }

    /** 找到指定文档对应的 protyle 实例，用于刷新界面 */
    protyleOf(docId) {
        const list = typeof getAllEditor === "function" ? getAllEditor() : [];
        return (
            list
                .filter((e) => e && e.protyle && e.protyle.block)
                .find((e) => e.protyle.block.rootID === docId)?.protyle || null
        );
    }

    /**
     * 设置完属性后刷新界面。
     *
     * /api/attr/setBlockAttrs 只写数据，不更新 DOM。思源自己在收到 setAttrs 事务时
     * 是这么刷新的：background.ial.icon = ...; background.render(ial, block.rootID)。
     * 这里调用同一个方法，而不是手动拼 DOM —— 后者会漏掉主题、尺寸等细节。
     */
    refreshTitleIcon(docId, iconValue) {
        const protyle = this.protyleOf(docId);
        if (!protyle) return false;

        try {
            const bg = protyle.background;
            if (bg && typeof bg.render === "function") {
                if (!bg.ial) bg.ial = {};
                bg.ial.icon = iconValue;
                bg.render(bg.ial, protyle.block.rootID);
            }
            // 同步更新文件树里的文档图标
            protyle.model?.parent?.setDocIcon?.(iconValue);
            return true;
        } catch (err) {
            console.warn("[iTunes Covers] refresh failed", err);
            return false;
        }
    }

    /* ── 表情面板 tab ────────────────────────────── */

    /**
     * 把封面搜索做成表情面板里的一个真正 tab。
     *
     * 思源表情面板的结构：
     *   .emojis__tabheader  里一排 [data-type="tab-xxx"] 图标
     *   .emojis__tabbody    里对应一排 <div data-type="tab-xxx">，非当前的加 fn__none
     * 面板只有 368px 宽，所以这里用紧凑搜索框 + 小 chips + 密网格。
     */
    watchEmojiDialog() {
        const inject = () => {
            document.querySelectorAll(".emojis__tabheader").forEach((header) => {
                if (header.querySelector(".itc-emoji-tab")) return;
                const dialog = header.closest(".b3-dialog");
                const body = dialog && dialog.querySelector(".emojis__tabbody");
                const linkTab = header.querySelector('[data-type="tab-link"]');
                if (!body || !linkTab) return;

                // ── tab 图标 ──
                const tab = document.createElement("div");
                tab.className = "itc-emoji-tab ariaLabel block__icon block__icon--show";
                tab.setAttribute("data-type", "tab-itc");
                tab.setAttribute("aria-label", this.i18n.topbarTitle);
                tab.innerHTML = '<svg><use xlink:href="#iconItcCovers"></use></svg>';

                // ── tab 内容 ──
                const pane = document.createElement("div");
                pane.className = "fn__none itc-ep";
                pane.setAttribute("data-type", "tab-itc");
                pane.innerHTML = `
                    <div class="fn__hr"></div>
                    <div class="fn__flex">
                        <span class="fn__space"></span>
                        <label class="b3-form__icon fn__flex-1" style="overflow:initial;">
                            <svg class="b3-form__icon-icon"><use xlink:href="#iconSearch"></use></svg>
                            <input spellcheck="false" class="b3-form__icon-input b3-text-field fn__block itc-ep-search" placeholder="${this.esc(this.i18n.searchPlaceholder)}">
                        </label>
                        <span class="fn__space"></span>
                    </div>
                    <div class="itc-ep-chips"></div>
                    <div class="fn__hr"></div>
                    <div class="itc-ep-grid"></div>
                `;

                const input = pane.querySelector(".itc-ep-search");
                const chips = pane.querySelector(".itc-ep-chips");
                const grid = pane.querySelector(".itc-ep-grid");
                let group = "all";
                let results = [];
                let built = false;
                let searchToken = 0;
                let searchCtl = null;

                /**
                 * 这个表情面板是"设置图标"还是"插入正文"打开的？
                 *
                 * 思源内部用 B 变量区分（doc / notebook / insert），但没暴露给我们。
                 * 可观察的差异：垃圾桶按钮只在非 insert 模式下显示
                 * （源码里是 `${B==="insert"?" fn__none":""}`）。
                 */
                const isIconMode = () => {
                    const rm = dialog.querySelector('[data-action="remove"]');
                    return !!rm && !rm.classList.contains("fn__none");
                };

                /** 用一个封面：标头模式设图标，插入模式插正文 */
                const useItem = async (item, el) => {
                    if (el) el.style.opacity = "0.45";
                    let ok = false;
                    if (isIconMode()) {
                        ok = await this.applyIcon(this.activeDocId(), item);
                    } else {
                        ok = await this.insertToBody(item);
                    }
                    if (el) el.style.opacity = "";
                    if (ok) dialog.remove();
                    return ok;
                };

                const renderChips = () => {
                    chips.innerHTML = [{ id: "all", labelKey: "typeAll" }]
                        .concat(ENTITIES.map((e) => ({ id: e.id, labelKey: e.labelKey })))
                        .map(
                            (g) =>
                                `<button class="itc-ep-chip${g.id === group ? " on" : ""}" data-g="${g.id}">${this.esc(this.i18n[g.labelKey])}</button>`
                        )
                        .join("");
                };

                const showEmpty = (msg) => {
                    grid.innerHTML = `<div class="itc-ep-empty">${this.esc(msg)}</div>`;
                };

                const renderResults = () => {
                    if (!results.length) {
                        showEmpty(this.i18n.noResult);
                        return;
                    }
                    grid.innerHTML = results
                        .map((item) => {
                            const name = this.itemTitle(item);
                            const sub = String(item.artistName || "");
                            return `<div class="itc-ep-item" data-key="${this.esc(this.keyOf(item))}" title="${this.esc(name + (sub ? " / " + sub : ""))}">
                                <img src="${this.esc(item.artworkUrl100)}" loading="lazy" decoding="async" alt="">
                            </div>`;
                        })
                        .join("");
                };

                const doSearch = async () => {
                    const term = input.value.trim();
                    if (!term) {
                        results = [];
                        showEmpty(this.i18n.emptyKeyword);
                        return;
                    }
                    if (searchCtl) searchCtl.abort(new Error("superseded"));
                    searchCtl = new AbortController();
                    const token = ++searchToken;
                    showEmpty(this.i18n.searching);
                    try {
                        const items = await this.searchItunes(term, group, searchCtl.signal);
                        if (token !== searchToken) return;
                        results = items;
                        renderResults();
                    } catch (err) {
                        if (token !== searchToken) return;
                        results = [];
                        showEmpty(this.searchFailText(err));
                    }
                };

                chips.onclick = (e) => {
                    const el = e.target.closest(".itc-ep-chip");
                    if (!el) return;
                    group = el.getAttribute("data-g");
                    chips.querySelectorAll(".itc-ep-chip").forEach((c) => {
                        c.classList.toggle("on", c.getAttribute("data-g") === group);
                    });
                    // 搜索型接口不做联想：有关键词就立即重查，没有只切状态
                    if (input.value.trim()) {
                        doSearch();
                    } else {
                        results = [];
                        showEmpty(this.i18n.emptyKeyword);
                    }
                };

                grid.addEventListener("click", async (e) => {
                    const el = e.target.closest(".itc-ep-item");
                    if (!el) return;
                    const item = results.find((r) => this.keyOf(r) === el.getAttribute("data-key"));
                    if (!item) return;
                    await useItem(item, el);
                });

                this.bindSearchInput(input, {
                    onQuery: () => {}, // 搜索型接口：不在击键时请求，只在回车时查
                    onEnter: async () => {
                        if (!results.length) {
                            await doSearch();
                            return;
                        }
                        const first = grid.querySelector(".itc-ep-item");
                        if (!first) return;
                        const item = results.find((r) => this.keyOf(r) === first.getAttribute("data-key"));
                        if (item) await useItem(item, first);
                    },
                    onEscape: () => {
                        if (input.value) {
                            input.value = "";
                            results = [];
                            showEmpty(this.i18n.emptyKeyword);
                        }
                    },
                });

                const activate = () => {
                    header.querySelectorAll('[data-type^="tab-"]').forEach((t) => {
                        t.classList.toggle("block__icon--active", t === tab);
                    });
                    [...body.children].forEach((c) => c.classList.add("fn__none"));
                    pane.classList.remove("fn__none");
                    if (!built) {
                        built = true;
                        renderChips();
                        showEmpty(this.i18n.emptyKeyword);
                    }
                    setTimeout(() => input.focus(), 30);
                };

                tab.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    activate();
                });

                // 点到别的 tab 时把我的内容收起来
                header.addEventListener(
                    "click",
                    (e) => {
                        const t = e.target.closest('[data-type^="tab-"]');
                        if (t && t !== tab) tab.classList.remove("block__icon--active");
                    },
                    true
                );

                const space = linkTab.nextElementSibling;
                if (space && space.classList.contains("fn__space")) {
                    space.insertAdjacentElement("afterend", tab);
                } else {
                    linkTab.insertAdjacentElement("afterend", tab);
                }
                body.appendChild(pane);
            });
        };

        inject();
        // 注意：onunload 里必须 disconnect，否则插件重载后会注入第二个 tab
        this.emojiObserver = new MutationObserver(() => inject());
        this.emojiObserver.observe(document.body, { childList: true, subtree: true });
    }

    /* ── 选择器 ──────────────────────────────────── */

    openPicker(docId) {
        const targetId = typeof docId === "string" ? docId : this.activeDocId();
        // 打开瞬间记下光标位置：对话框一弹，选区就没了
        this.savedBlockCtx = this.currentBlockContext();

        const TYPES = [
            { id: "all", label: this.i18n.typeAll },
            { id: "ebook", label: this.i18n.typeBook },
            { id: "album", label: this.i18n.typeAlbum },
            { id: "tvSeason", label: this.i18n.typeTv },
        ];

        const dialog = new Dialog({
            title: this.i18n.pickerTitle,
            width: "920px",
            height: "680px",
            content: `<div class="b3-dialog__content" style="overflow:hidden;display:flex;padding:12px 16px">
    <div class="itc">
        <div class="itc-bar">
            <input class="b3-text-field itc-search" placeholder="${this.esc(this.i18n.searchPlaceholder)}" autocomplete="off" spellcheck="false">
        </div>
        <div class="itc-chips"></div>
        <div class="itc-meta">
            <span class="itc-count"></span>
            <span class="itc-hint">${this.esc(this.i18n.hint)}</span>
        </div>
        <div class="itc-scroll"><div class="itc-grid"></div></div>
    </div>
</div>`,
        });

        const root = dialog.element;
        const input = root.querySelector(".itc-search");
        const grid = root.querySelector(".itc-grid");
        const chips = root.querySelector(".itc-chips");
        const countEl = root.querySelector(".itc-count");

        let group = "all";
        let results = [];
        let searchToken = 0;
        let searchCtl = null;
        // 上一次成功查询对应的 group|term，回车时用来区分「重查」和「插第一个结果」
        let lastQuery = "";

        const showEmpty = (msg) => {
            grid.innerHTML = `<div class="itc-empty">${this.esc(msg)}</div>`;
        };

        const showGuide = () => {
            countEl.textContent = "";
            showEmpty(this.i18n.emptyKeyword);
        };

        const doSearch = async () => {
            const term = input.value.trim();
            if (!term) {
                results = [];
                lastQuery = "";
                showGuide();
                return;
            }
            // 新查询替换旧查询：中断还在路上的旧请求
            if (searchCtl) searchCtl.abort(new Error("superseded"));
            searchCtl = new AbortController();
            const token = ++searchToken;
            countEl.textContent = this.i18n.searching;
            showEmpty(this.i18n.searching);
            try {
                const items = await this.searchItunes(term, group, searchCtl.signal);
                if (token !== searchToken) return;
                results = items;
                lastQuery = `${group}|${term}`;
                countEl.textContent = this.i18n.countResult.replace("$1", String(results.length));
                if (!results.length) {
                    showEmpty(this.i18n.noResult);
                    return;
                }
                grid.innerHTML = results
                    .map((item, i) => {
                        const name = this.itemTitle(item);
                        const sub = String(item.artistName || "");
                        return `<div class="itc-card" data-i="${i}" title="${this.esc(name + (sub ? " / " + sub : ""))}">
    <div class="itc-art"><img src="${this.esc(this.coverUrl(item, THUMB_SIZE))}" loading="lazy" decoding="async" alt=""></div>
    <span class="itc-name">${this.esc(name)}</span>
    <span class="itc-badge">${this.esc(item.__label || "")}</span>
    <div class="itc-acts">
        <button data-act="docicon" aria-label="${this.esc(this.i18n.setAsDocIcon)}" title="${this.esc(this.i18n.setAsDocIcon)}"><svg><use xlink:href="#iconItcDoc"></use></svg></button>
    </div>
</div>`;
                    })
                    .join("");
            } catch (err) {
                if (token !== searchToken) return;
                results = [];
                lastQuery = "";
                countEl.textContent = this.i18n.searchFailed;
                // 失败也要给出行内提示，不能白屏
                showEmpty(this.searchFailText(err));
            }
        };

        const renderChips = () => {
            chips.innerHTML = TYPES.map(
                (g) => `<button class="itc-chip${g.id === group ? " on" : ""}" data-g="${g.id}">${this.esc(g.label)}</button>`
            ).join("");
        };

        chips.onclick = (e) => {
            const el = e.target.closest(".itc-chip");
            if (!el) return;
            group = el.getAttribute("data-g");
            chips.querySelectorAll(".itc-chip").forEach((c) => {
                c.classList.toggle("on", c.getAttribute("data-g") === group);
            });
            // 有关键词立即用新 entity 重查；没有只切状态，不发请求
            if (input.value.trim()) {
                doSearch();
            } else {
                results = [];
                lastQuery = "";
                showGuide();
            }
        };

        const useCard = async (item, card) => {
            card.classList.add("busy");
            try {
                const ok = await this.insertToBody(item);
                if (ok) {
                    showMessage(this.i18n.inserted.replace("$1", this.itemTitle(item)), 2000, "info");
                    dialog.destroy();
                } else {
                    showMessage(this.i18n.insertFailed);
                }
            } finally {
                card.classList.remove("busy");
            }
        };

        grid.onclick = async (e) => {
            const card = e.target.closest(".itc-card");
            if (!card) return;
            const item = results[Number(card.getAttribute("data-i"))];
            if (!item) return;

            const btn = e.target.closest("button[data-act]");
            if (btn && btn.getAttribute("data-act") === "docicon") {
                // 悬停按钮：设为文档图标
                card.classList.add("busy");
                try {
                    const ok = await this.applyIcon(targetId, item);
                    if (ok) dialog.destroy();
                } finally {
                    card.classList.remove("busy");
                }
                return;
            }
            // 卡片本体：插入到正文光标处
            await useCard(item, card);
        };

        grid.oncontextmenu = (e) => {
            const card = e.target.closest(".itc-card");
            if (!card) return;
            e.preventDefault();
            const item = results[Number(card.getAttribute("data-i"))];
            if (!item) return;
            const menu = new Menu("itc-menu");
            menu.addItem({
                icon: "iconImage",
                label: this.i18n.insertBody,
                click: async () => {
                    await useCard(item, card);
                },
            });
            menu.addItem({
                icon: "iconDoc",
                label: this.i18n.setAsDocIcon,
                click: async () => {
                    if (await this.applyIcon(targetId, item)) dialog.destroy();
                },
            });
            menu.open({ x: e.clientX, y: e.clientY });
        };

        this.bindSearchInput(input, {
            onQuery: () => {}, // 搜索型接口：不在击键时请求，避免打断输入法候选框
            onEnter: async () => {
                const term = input.value.trim();
                if (!term || lastQuery !== `${group}|${term}` || !results.length) {
                    await doSearch();
                    return;
                }
                // 同一查询再按回车：插入第一个结果
                const card = grid.querySelector(".itc-card");
                if (!card) return;
                const item = results[Number(card.getAttribute("data-i"))];
                if (item) await useCard(item, card);
            },
            onEscape: () => {
                if (input.value) {
                    input.value = "";
                    results = [];
                    lastQuery = "";
                    showGuide();
                } else {
                    dialog.destroy();
                }
            },
        });

        renderChips();
        showGuide();
        setTimeout(() => input.focus(), 60);
    }

    /**
     * 绑定搜索框：处理好中文输入法。
     *
     * 关键点：用 IME 组词时按回车是「确认候选词」，不是「提交」。
     * 不做判断的话，输入 "dee" 再回车会直接提交半截关键词。
     * - 组词中（isComposing / keyCode 229）不响应回车
     * - 组词中不触发查询，否则每敲一个字母就重渲染，输入法候选框会被打断
     */
    bindSearchInput(input, { onQuery, onEnter, onEscape }) {
        let composing = false;

        input.addEventListener("compositionstart", () => {
            composing = true;
        });
        input.addEventListener("compositionend", () => {
            composing = false;
            // 组词结束后再按最终文本查一次
            onQuery(input.value);
        });
        input.addEventListener("input", () => {
            if (composing) return;
            onQuery(input.value);
        });
        input.addEventListener("keydown", (e) => {
            // 输入法正在组词，任何键都交给输入法处理
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") {
                e.preventDefault();
                if (onEnter) onEnter();
            } else if (e.key === "Escape") {
                if (onEscape) onEscape(e);
            }
        });
    }

    esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
        );
    }

    /** 搜索失败文案：timeout / superseded 属正常路径，不抖英文细节 */
    searchFailText(err) {
        const msg = (err && err.message) || "";
        return msg && msg !== "timeout" && msg !== "superseded"
            ? `${this.i18n.searchFailed}: ${msg}`
            : this.i18n.searchFailed;
    }
};
