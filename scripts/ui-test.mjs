/**
 * UI 集成测试：在真实 DOM（jsdom）里跑 openPicker / watchEmojiDialog，
 * 验证对话框结构、iTunes 搜索参数、chips 切换、点击插入正文、设为文档图标、
 * IME 安全、表情面板注入、失败兜底。
 *
 * 运行：node scripts/ui-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "index.js"), "utf8");

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { url: "http://127.0.0.1:6806/" });
const { window } = dom;

/* ── 测试数据 ───────────────────────────────────── */
const mkCover = (id) =>
    `https://is1-ssl.mzstatic.com/image/thumb/Publication${id}/v4/ab/cd/ef/cover${id}.d.jpg/100x100bb.jpg`;
const FIXTURES = {
    ebook: [
        { trackId: 101, trackName: "三体", artistName: "刘慈欣", artworkUrl100: mkCover(101), kind: "ebook" },
        { trackId: 102, trackName: "球状闪电", artistName: "刘慈欣", artworkUrl100: mkCover(102), kind: "ebook" },
        { trackId: 103, trackName: "无封面", artistName: "x" },
    ],
    album: [{ trackId: 201, collectionName: "范特西", artistName: "周杰伦", artworkUrl100: mkCover(201) }],
    tvSeason: [{ trackId: 301, collectionName: "三体 第一季", artistName: "三体", artworkUrl100: mkCover(301) }],
};

/* ── 网络桩 ─────────────────────────────────────── */
const searchCalls = [];
const putFileCalls = [];
const uploadCalls = [];
const attrCalls = [];
const insertBlockCalls = [];
const emojiFiles = new Set();
const mzstaticUrls = [];
let groupDirExists = false;
let failAll = false;
let mzstaticCalls = 0;

class FakeFormData {
    constructor() {
        this.entries = [];
    }
    append(k, v, name) {
        this.entries.push([k, v, name]);
    }
    get(k) {
        const hit = this.entries.find((e) => e[0] === k);
        return hit ? hit[1] : null;
    }
}
class FakeBlob {
    constructor(parts) {
        this.parts = parts || [];
    }
}

const fetchStub = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith("https://itunes.apple.com/search")) {
        const params = new URL(u).searchParams;
        const entity = params.get("entity");
        searchCalls.push({
            url: u,
            term: params.get("term"),
            country: params.get("country"),
            entity,
            limit: params.get("limit"),
        });
        if (failAll) return { ok: false, status: 500, json: async () => ({}) };
        const results = FIXTURES[entity] || [];
        return { ok: true, status: 200, json: async () => ({ resultCount: results.length, results }) };
    }
    if (u.includes("/api/file/readDir")) {
        if (!groupDirExists) return { json: async () => ({ code: 404, data: null }) };
        return {
            json: async () => ({
                code: 0,
                data: [...emojiFiles].map((n) => ({ name: n, isDir: false })),
            }),
        };
    }
    if (u.includes("/api/file/putFile")) {
        const fd = opts.body;
        const p = fd.get("path");
        const name = p.split("/").pop();
        emojiFiles.add(name);
        putFileCalls.push({ path: p, name });
        return { json: async () => ({ code: 0, data: null }) };
    }
    if (u.includes("/api/attr/setBlockAttrs")) {
        const body = JSON.parse(opts.body);
        attrCalls.push(body);
        return { json: async () => ({ code: 0, data: null }) };
    }
    if (u.includes("/api/asset/upload")) {
        const fd = opts.body;
        const fileEntry = fd.entries.find((e) => e[0] === "file[]");
        const name = fileEntry ? fileEntry[2] : "unknown.jpg";
        const dir = fd.get("assetsDirPath") || "/assets/";
        uploadCalls.push({ dir, name });
        return {
            json: async () => ({
                code: 0,
                data: { succMap: { [name]: dir + name } },
            }),
        };
    }
    if (u.includes("/api/block/insertBlock")) {
        insertBlockCalls.push(JSON.parse(opts.body));
        return { json: async () => ({ code: 0 }) };
    }
    if (u.includes("mzstatic.com")) {
        mzstaticCalls++;
        mzstaticUrls.push(u);
        return { ok: true, status: 200, blob: async () => new FakeBlob(["jpg-bytes"]) };
    }
    return { ok: false, status: 404, json: async () => ({ code: 404 }) };
};

/* ── siyuan 模块桩 ──────────────────────────────── */
class FakePlugin {
    constructor() {
        this.name = "siyuan-plugin-iTunes-covers";
        this.i18n = JSON.parse(fs.readFileSync(path.join(root, "i18n", "zh_CN.json"), "utf8"));
        this.eventBus = { on() {} };
        this.breadcrumbBtns = [];
    }
    addIcons() {}
    addCommand() {}
    addTopBar() {}
    addBreadcrumbButton(b) { this.breadcrumbBtns.push(b); return b.id; }
}

const messages = [];
const fakeDialog = class {
    constructor(opts) {
        this.opts = opts;
        const wrap = window.document.createElement("div");
        wrap.innerHTML = opts.content;
        this.element = wrap;
        window.document.body.appendChild(wrap);
    }
    destroy() {
        this.element.remove();
    }
};

/* 编辑器桩 */
const UI_DOC_ID = "20260202-uidoc";
let uiIconRefreshed = null;
const wysiwygEl = window.document.createElement("div");
wysiwygEl.className = "protyle-wysiwyg";
Object.defineProperty(wysiwygEl, "isConnected", { get: () => true });
window.document.body.appendChild(wysiwygEl);

const fakeProtyle = {
    block: { rootID: UI_DOC_ID },
    element: { classList: { contains: () => false }, contains: () => true },
    wysiwyg: { element: wysiwygEl },
    focus() {},
    insert(html) {
        const tpl = window.document.createElement("div");
        tpl.innerHTML = html;
        while (tpl.firstChild) wysiwygEl.appendChild(tpl.firstChild);
    },
    background: {
        ial: {},
        render() { uiIconRefreshed = this.ial.icon; },
    },
    model: { parent: { setDocIcon: (v) => { uiIconRefreshed = v; } } },
};

const menuInstances = [];
class FakeMenu {
    constructor() { this.items = []; menuInstances.push(this); }
    addItem(i) { this.items.push(i); }
    addSeparator() {}
    open() {}
    findByLabel(l) { return this.items.find((i) => i.label === l); }
}

const sandbox = {
    console,
    fetch: fetchStub,
    URL,
    URLSearchParams,
    document: window.document,
    window,
    setTimeout,
    clearTimeout,
    AbortController, // 平台自带的就够用，不造假件
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    MutationObserver: window.MutationObserver,
    KeyboardEvent: window.KeyboardEvent,
    FormData: FakeFormData,
    Blob: FakeBlob,
    require: (m) => (m === "siyuan" ? {
        Plugin: FakePlugin,
        Dialog: fakeDialog,
        Menu: FakeMenu,
        showMessage: (msg) => messages.push(msg),
        getAllEditor: () => [{ protyle: fakeProtyle }],
    } : null),
    module: { exports: {} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "index.js" });
const Plugin = sandbox.module.exports;

const p = new Plugin();
await p.onload();

const q = (sel) => window.document.querySelector(sel);
const qa = (sel) => [...window.document.querySelectorAll(sel)];
const cards = () => qa(".itc-card");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const closeAllDialogs = () => qa(".itc").forEach((el) => el.remove());

console.log("1) 打开选择器（初始状态）");
p.openPicker(UI_DOC_ID);
check("根容器 .itc 存在", !!q(".itc"));
check("有搜索框", !!q(".itc-search"));
check("有类型 chips（4 个）", qa(".itc-chip").length === 4, `实际 ${qa(".itc-chip").length}`);
check("chips 为 全部/书/专辑/剧集", qa(".itc-chip").map((c) => c.textContent).join("/") === "全部/书/专辑/剧集",
    qa(".itc-chip").map((c) => c.textContent).join("/"));
check("默认停在「全部」", qa(".itc-chip").find((c) => c.dataset.g === "all")?.classList.contains("on"));
check("未搜索时显示引导文案", q(".itc-empty")?.textContent === "先输入关键词再搜索", q(".itc-empty")?.textContent);
check("初始不发任何请求", searchCalls.length === 0, `实际 ${searchCalls.length}`);

console.log("2) 搜索：每次击键不发请求，回车才查「全部」");
const input = q(".itc-search");
input.value = "三体";
input.dispatchEvent(new window.Event("input", { bubbles: true }));
check("输入过程不发请求（搜索型接口不做联想）", searchCalls.length === 0, `实际 ${searchCalls.length}`);

input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await wait(150);
check("回车并发 3 个请求", searchCalls.length === 3, `实际 ${searchCalls.length}`);
check(
    "entity 分别是 ebook/album/tvSeason",
    JSON.stringify(searchCalls.map((c) => c.entity)) === JSON.stringify(["ebook", "album", "tvSeason"]),
    searchCalls.map((c) => c.entity).join(",")
);
check("每个请求 limit=12、country=us",
    searchCalls.every((c) => c.limit === "12" && c.country === "us"));
check("中文 term 已编码",
    searchCalls[0].url.includes("term=%E4%B8%89%E4%BD%93") && searchCalls.every((c) => c.term === "三体"),
    searchCalls[0].url);
check("渲染出 4 张卡片（无封面结果被过滤）", cards().length === 4, `实际 ${cards().length}`);
check("第一张卡片是 ebook 的三体",
    cards()[0]?.querySelector(".itc-name")?.textContent === "三体" && cards()[0].title === "三体 / 刘慈欣",
    cards()[0]?.title);
check("卡片角标显示类型", cards().map((c) => c.querySelector(".itc-badge")?.textContent).join("/") === "书/书/专辑/剧集",
    cards().map((c) => c.querySelector(".itc-badge")?.textContent).join("/"));
check("卡片 img 用 600x600bb 缩略图", cards()[0]?.querySelector("img")?.getAttribute("src").includes("600x600bb"),
    cards()[0]?.querySelector("img")?.getAttribute("src"));
check("计数为 共 4 个结果", q(".itc-count")?.textContent === "共 4 个结果", q(".itc-count")?.textContent);

console.log("3) 点击卡片 = 插入正文（不动文档图标）");
searchCalls.length = 0;
wysiwygEl.innerHTML = "";
putFileCalls.length = 0;
uploadCalls.length = 0;
attrCalls.length = 0;
cards()[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(200);

check("没有调用 setBlockAttrs", attrCalls.length === 0, `实际 ${attrCalls.length}`);
check("调用了 /api/asset/upload", uploadCalls.length === 1, `实际 ${uploadCalls.length}`);
check("assetsDirPath 以 /assets/iTunes-covers/ 结尾（含结尾斜杠）",
    uploadCalls[0]?.dir === "/assets/iTunes-covers/", uploadCalls[0]?.dir);
check("插入的封面仍下载 3000 原图", mzstaticUrls.some((u) => u.includes("3000x3000bb")),
    mzstaticUrls.join(","));
check("没有写表情组（正文插图不碰 emojis）", putFileCalls.length === 0);
const insertedImg = wysiwygEl.querySelector("img");
check("正文里插入了 img", !!insertedImg);
check("img 指向 /assets/iTunes-covers/", (insertedImg?.getAttribute("src") || "").startsWith("/assets/iTunes-covers/"),
    insertedImg?.getAttribute("src"));
check("img 有 alt", insertedImg?.getAttribute("alt") === "三体", insertedImg?.getAttribute("alt"));
check("对话框已关闭", !q(".itc"));
check("提示已插入", messages.some((m) => m.includes("已插入")), messages.join("|"));

console.log("4) 悬停按钮 = 设为文档图标");
p.openPicker(UI_DOC_ID);
await wait(30);
q(".itc-search").value = "三体";
q(".itc-search").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await wait(150);
uploadCalls.length = 0;
attrCalls.length = 0;
uiIconRefreshed = null;
const actBtn = cards()[0].querySelector('button[data-act="docicon"]');
check("卡片有设为文档图标按钮", !!actBtn);
actBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(250);

const attrCall = attrCalls[0];
check("点按钮才调 setBlockAttrs", attrCalls.length === 1, `实际 ${attrCalls.length}`);
check("块 id 正确", attrCall?.id === UI_DOC_ID, attrCall?.id);
check("icon 值为 iTunes-covers/<文件>.jpg", /^iTunes-covers\/.+\.(jpg|png)$/.test(attrCall?.attrs?.icon || ""),
    attrCall?.attrs?.icon);
check("封面文件写入表情组", putFileCalls.some((c) => c.name === attrCall?.attrs?.icon?.split("/")[1]),
    putFileCalls.map((c) => c.name).join(","));
check("putFile 路径为 /data/emojis/iTunes-covers/",
    putFileCalls.every((c) => c.path.startsWith("/data/emojis/iTunes-covers/")));
check("设置图标不重复上传 assets", uploadCalls.length === 0, `实际 ${uploadCalls.length}`);
check("界面刷新已触发", uiIconRefreshed === attrCall?.attrs?.icon, String(uiIconRefreshed));
check("对话框已关闭", !q(".itc"));

console.log("5) IME：组词期间回车不提交");
p.openPicker(UI_DOC_ID);
await wait(30);
const imeInput = q(".itc-search");
const beforeIme = searchCalls.length;

imeInput.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
imeInput.value = "dee";
imeInput.dispatchEvent(new window.Event("input", { bubbles: true }));
await wait(50);
check("组词期间不发请求", searchCalls.length === beforeIme);

imeInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
await wait(80);
check("isComposing 回车不提交", searchCalls.length === beforeIme && !!q(".itc-empty"));

imeInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }));
await wait(80);
check("keyCode 229 回车也不提交", searchCalls.length === beforeIme);

imeInput.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true }));
await wait(50);
check("compositionend 只记词不请求", searchCalls.length === beforeIme);

imeInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await wait(150);
check("组词结束后回车用最终文本查询", searchCalls.length === beforeIme + 3 && searchCalls[beforeIme].term === "dee",
    searchCalls.slice(beforeIme).map((c) => c.term).join(","));
check("dee 也有结果", cards().length === 4);

console.log("6) Esc：先清空，再关闭");
imeInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
check("Esc 清空搜索框并回到引导", imeInput.value === "" && q(".itc-empty")?.textContent === "先输入关键词再搜索",
    q(".itc-empty")?.textContent);
imeInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
check("再次 Esc 关闭面板", !q(".itc"));

console.log("7) 同一查询再按回车 = 插入第一个结果");
p.openPicker(UI_DOC_ID);
await wait(30);
q(".itc-search").value = "三体";
q(".itc-search").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await wait(150);
const beforeReenter = searchCalls.length;
wysiwygEl.innerHTML = "";
q(".itc-search").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await wait(200);
check("未重新搜索", searchCalls.length === beforeReenter);
check("回车插入了第一个结果", !!wysiwygEl.querySelector("img"));
closeAllDialogs();

console.log("8) chips 切换改写 entity 参数");
p.openPicker(UI_DOC_ID);
await wait(30);
q(".itc-search").value = "三体";
q(".itc-search").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await wait(150);

searchCalls.length = 0;
qa(".itc-chip").find((c) => c.dataset.g === "album")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(150);
check("点「专辑」只发 1 个请求", searchCalls.length === 1, `实际 ${searchCalls.length}`);
check("请求 entity=album", searchCalls[0]?.url.includes("entity=album"), searchCalls[0]?.url);
check("单 entity limit=36", searchCalls[0]?.limit === "36");
check("只显示专辑卡片", cards().length === 1 && cards()[0].querySelector(".itc-badge")?.textContent === "专辑",
    cards().map((c) => c.querySelector(".itc-badge")?.textContent).join("/"));
check("chip 选中态切换", qa(".itc-chip").find((c) => c.dataset.g === "album")?.classList.contains("on")
    && !qa(".itc-chip").find((c) => c.dataset.g === "all")?.classList.contains("on"));

searchCalls.length = 0;
qa(".itc-chip").find((c) => c.dataset.g === "ebook")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(150);
check("点「书」请求 entity=ebook", searchCalls.length === 1 && searchCalls[0].url.includes("entity=ebook"));
check("只显示书", cards().length === 2 && cards().every((c) => c.querySelector(".itc-badge")?.textContent === "书"));

searchCalls.length = 0;
q(".itc-search").value = "";
qa(".itc-chip").find((c) => c.dataset.g === "tvSeason")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(80);
check("搜索框为空时切 chip 不发请求", searchCalls.length === 0);
check("只切状态并显示引导文案", q(".itc-empty")?.textContent === "先输入关键词再搜索", q(".itc-empty")?.textContent);
closeAllDialogs();

console.log("9) 右键菜单两个选项都在");
p.openPicker(UI_DOC_ID);
await wait(30);
q(".itc-search").value = "三体";
q(".itc-search").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await wait(150);
menuInstances.length = 0;
cards()[0].dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
const capturedMenu = menuInstances[menuInstances.length - 1];
check("右键弹出菜单", !!capturedMenu);
check("菜单含「插入到正文」", !!capturedMenu?.findByLabel("插入到正文"),
    capturedMenu?.items.map((i) => i.label).join(","));
check("菜单含「设为文档图标」", !!capturedMenu?.findByLabel("设为文档图标"),
    capturedMenu?.items.map((i) => i.label).join(","));
closeAllDialogs();

console.log("10) 无编辑器时降级到 insertBlock API");
insertBlockCalls.length = 0;
const realProtyles = p.collectProtyles;
p.collectProtyles = () => [];
p.openPicker(UI_DOC_ID);
await wait(30);
q(".itc-search").value = "三体";
q(".itc-search").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await wait(150);
cards()[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(200);
check("降级调用了 insertBlock", insertBlockCalls.length === 1, `实际 ${insertBlockCalls.length}`);
check("插入的是 markdown 图片", /!\[三体\]\(\/assets\/iTunes-covers\/.+\.(jpg|png)\)/.test(insertBlockCalls[0]?.data || ""),
    insertBlockCalls[0]?.data);
p.collectProtyles = realProtyles;
closeAllDialogs();

console.log("11) 表情面板内嵌 tab");
window.document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="b3-dialog"><div class="emojis">
        <div class="emojis__tabheader">
            <div data-type="tab-emoji" class="block__icon"></div><div class="fn__space"></div>
            <div data-type="tab-custom" class="block__icon"></div><div class="fn__space"></div>
            <div data-type="tab-dynamic" class="block__icon"></div><div class="fn__space"></div>
            <div data-type="tab-link" class="block__icon"></div><div class="fn__space"></div>
        </div>
        <div class="emojis__tabbody">
            <div data-type="tab-emoji"></div>
            <div class="fn__none" data-type="tab-dynamic"></div>
        </div>
     </div></div>`
);
p.watchEmojiDialog();

const tab = q(".itc-emoji-tab");
check("注入了 tab 图标", !!tab);
check("tab 带插件图标", /iconItcCovers/.test(tab?.innerHTML || ""));
check("tab 带 data-type=tab-itc", tab?.getAttribute("data-type") === "tab-itc");
check("注入了对应内容面板", !!q('.itc-ep[data-type="tab-itc"]'));
check("面板自带紧凑搜索框", !!q(".itc-ep-search"));

const beforeInj = qa(".itc-emoji-tab").length;
p.watchEmojiDialog();
check("重复调用不会注入第二个 tab", qa(".itc-emoji-tab").length === beforeInj,
    `实际 ${qa(".itc-emoji-tab").length}`);

tab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(60);
const pane = q(".itc-ep");
check("点击后内容面板展开", !pane.classList.contains("fn__none"));
check("tab 变为选中态", tab.classList.contains("block__icon--active"));
check("其他 tab 内容被收起",
    q('.emojis__tabbody > [data-type="tab-emoji"]').classList.contains("fn__none"));
check("面板带 4 个小 chips（展开时渲染）", qa(".itc-ep-chip").length === 4, `实际 ${qa(".itc-ep-chip").length}`);
check("初始显示引导文案", q(".itc-ep-empty")?.textContent === "先输入关键词再搜索", q(".itc-ep-empty")?.textContent);

const beforePane = searchCalls.length;
const epInput = q(".itc-ep-search");
epInput.value = "三体";
epInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await wait(150);
check("面板内回车也走 iTunes 搜索", searchCalls.length === beforePane + 3);
check("面板渲染封面网格", qa(".itc-ep-item").length === 4, `实际 ${qa(".itc-ep-item").length}`);
check("面板缩略图用原始 100x100bb", q(".itc-ep-item img")?.getAttribute("src").includes("100x100bb"),
    q(".itc-ep-item img")?.getAttribute("src"));

console.log("12) 标头模式（垃圾桶可见）→ 只设图标不插正文");
q(".b3-dialog").insertAdjacentHTML("beforeend", '<span class="block__icon" data-action="remove"></span>');
searchCalls.length = 0;
wysiwygEl.innerHTML = "";
uploadCalls.length = 0;
attrCalls.length = 0;
uiIconRefreshed = null;

q(".itc-ep-item").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(250);

check("调用了 setBlockAttrs", attrCalls.length === 1);
check("icon 值格式正确", /^iTunes-covers\/.+\.(jpg|png)$/.test(attrCalls[0]?.attrs?.icon || ""),
    attrCalls[0]?.attrs?.icon);
check("没有插入到正文", !wysiwygEl.querySelector("img"));
check("没有上传 assets", uploadCalls.length === 0, `实际 ${uploadCalls.length}`);
check("标题图标已刷新", !!uiIconRefreshed, String(uiIconRefreshed));
check("面板用完关闭", !q(".emojis"));

console.log("13) 插入模式（垃圾桶 fn__none）→ 只插正文不改图标");
window.document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="b3-dialog"><div class="emojis">
        <div class="emojis__tabheader">
            <div data-type="tab-link" class="block__icon"></div><div class="fn__space"></div>
            <span class="block__icon fn__none" data-action="remove"></span>
        </div>
        <div class="emojis__tabbody"><div data-type="tab-emoji"></div></div>
     </div></div>`
);
p.watchEmojiDialog(); // 面板已进 DOM，注入
await wait(30);
const tab2 = [...qa(".itc-emoji-tab")].pop();
tab2.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(60);
// 新面板是全新闭包，先搜一次才有结果
const epInput2 = [...qa(".itc-ep-search")].pop();
epInput2.value = "三体";
epInput2.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await wait(150);
searchCalls.length = 0;
attrCalls.length = 0;
uploadCalls.length = 0;
wysiwygEl.innerHTML = "";
const items2 = qa(".itc-ep-item");
check("插入模式面板渲染出结果", items2.length === 4, `实际 ${items2.length}`);
items2[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(250);

check("插入模式不改文档图标", attrCalls.length === 0, `实际 ${attrCalls.length}`);
check("插入模式下正文出现图片", !!wysiwygEl.querySelector("img"));
check("插入模式图片指向 assets",
    (wysiwygEl.querySelector("img")?.getAttribute("src") || "").includes("/assets/iTunes-covers/"),
    wysiwygEl.querySelector("img")?.getAttribute("src"));
check("同一封面命中缓存不重复上传", uploadCalls.length === 0, `实际 ${uploadCalls.length}`);
qa(".b3-dialog").forEach((el) => el.remove());

console.log("14) 搜索失败显示错误文案，不白屏");
failAll = true;
p.openPicker(UI_DOC_ID);
await wait(30);
q(".itc-search").value = "三体";
q(".itc-search").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await wait(150);
check("计数行显示搜索失败", q(".itc-count")?.textContent === "搜索失败", q(".itc-count")?.textContent);
check("网格内有错误提示（不白屏）", (q(".itc-empty")?.textContent || "").includes("搜索失败"),
    q(".itc-empty")?.textContent);
check("对话框结构仍在", !!q(".itc") && !!q(".itc-grid"));
check("不残留卡片", cards().length === 0);
failAll = false;
closeAllDialogs();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
