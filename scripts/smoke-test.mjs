/**
 * 无头冒烟测试：用桩替代 siyuan 模块和浏览器环境，验证插件纯逻辑。
 * 覆盖：生命周期注册、iTunes 参数拼装（entity / limit / country / 中文编码）、
 *       名称字段选择、文件名清洗、图标 putFile 流水线、assets 上传缓存、界面刷新。
 *
 * 运行：node scripts/smoke-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "index.js"), "utf8");

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
    if (cond) {
        pass++;
        console.log(`  ✓ ${name}`);
    } else {
        fail++;
        console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
    }
};

/* ── 测试数据 ───────────────────────────────────── */
const mkCover = (id) =>
    `https://is1-ssl.mzstatic.com/image/thumb/Publication${id}/v4/ab/cd/ef/cover${id}.d.jpg/100x100bb.jpg`;
const FIXTURES = {
    ebook: [
        { trackId: 101, trackName: "三体", artistName: "刘慈欣", artworkUrl100: mkCover(101), kind: "ebook" },
        { trackId: 102, trackName: "球状闪电", artistName: "刘慈欣", artworkUrl100: mkCover(102), kind: "ebook" },
        { trackId: 103, trackName: "无封面", artistName: "x" }, // 没有 artwork，应被过滤
    ],
    album: [{ trackId: 201, collectionName: "范特西", artistName: "周杰伦", artworkUrl100: mkCover(201) }],
    tvSeason: [{ trackId: 301, collectionName: "三体 第一季", artistName: "三体", artworkUrl100: mkCover(301) }],
};
const EBOOK_ITEM = FIXTURES.ebook[0];
const ALBUM_ITEM = FIXTURES.album[0];
const TV_ITEM = FIXTURES.tvSeason[0];

/* ── 网络桩 ─────────────────────────────────────── */
const DOC_ID = "20260101-rootdoc";
let iconRefreshed = null;
const fakeProtyle = {
    id: "protyle-1",
    block: { rootID: DOC_ID, id: DOC_ID },
    element: {
        classList: { contains: () => false },
        contains: () => false,
        querySelector: () => null,
    },
    title: { element: { querySelector: () => null } },
    background: {
        ial: {},
        render() {
            iconRefreshed = this.ial.icon;
        },
    },
    model: { parent: { setDocIcon: (v) => { iconRefreshed = v; } } },
};

const searchCalls = [];
const putFileCalls = [];
const uploadCalls = [];
const attrCalls = [];
const emojiFiles = new Set();
let groupDirExists = false;
let failEntity = null; // 指定 entity 返回 500
let failAll = false; // 全部搜索返回 500
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
        if (failAll || entity === failEntity) {
            return { ok: false, status: 500, json: async () => ({}) };
        }
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
        attrCalls.push(JSON.parse(opts.body));
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
    if (u.includes("mzstatic.com")) {
        mzstaticCalls++;
        return { ok: true, status: 200, blob: async () => new FakeBlob(["jpg-bytes"]) };
    }
    return { ok: false, status: 404, json: async () => ({ code: 404 }) };
};

/* ── 桩：siyuan 模块 ────────────────────────────── */
class FakePlugin {
    constructor() {
        this.name = "siyuan-plugin-iTunes-covers";
        this.i18n = new Proxy({}, { get: (_, k) => String(k) });
        this.eventBus = { on() {} };
        this.commands = [];
        this.topBars = [];
        this.symbols = [];
        this.breadcrumbBtns = [];
    }
    addIcons(s) { this.symbols.push(s); }
    addCommand(c) { this.commands.push(c); }
    addTopBar(t) { this.topBars.push(t); }
    addBreadcrumbButton(b) { this.breadcrumbBtns.push(b); return b.id; }
    async loadData() { return null; }
    async saveData(k, v) { (this.saved ||= {})[k] = v; }
}
const fakeDialog = class {
    constructor(opts) {
        this.opts = opts;
        this.element = { querySelector: () => null };
    }
    destroy() {}
};
const siyuanStub = {
    Plugin: FakePlugin,
    Dialog: fakeDialog,
    Menu: class { addItem() {} open() {} },
    showMessage: () => {},
    getAllEditor: () => [{ protyle: fakeProtyle }],
};

/* ── 桩：浏览器环境 ─────────────────────────────── */
const makeSandbox = () => {
    const sandbox = {
        console,
        fetch: fetchStub,
        URL,
        URLSearchParams,
        setTimeout,
        clearTimeout,
        AbortController, // 平台自带的就够用，不造假件
        FormData: FakeFormData,
        Blob: FakeBlob,
        document: {
            querySelector: () => null,
            querySelectorAll: () => [],
            body: {},
        },
        window: { getSelection: () => null, siyuan: {} },
        MutationObserver: class {
            observe() {}
            disconnect() {}
        },
        require: (m) => (m === "siyuan" ? siyuanStub : createRequire(import.meta.url)(m)),
        module: { exports: {} },
    };
    sandbox.exports = sandbox.module.exports;
    return sandbox;
};

const newPlugin = async () => {
    const sandbox = makeSandbox();
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: "index.js" });
    const PluginClass = sandbox.module.exports;
    const p = new PluginClass();
    await p.onload();
    return p;
};

const reset = () => {
    searchCalls.length = 0;
    putFileCalls.length = 0;
    uploadCalls.length = 0;
    attrCalls.length = 0;
    emojiFiles.clear();
    mzstaticCalls = 0;
    failEntity = null;
    failAll = false;
    groupDirExists = false;
};

console.log("1) 语法解析");
let PluginClass;
{
    const sandbox = makeSandbox();
    vm.createContext(sandbox);
    try {
        vm.runInContext(src, sandbox, { filename: "index.js" });
        PluginClass = sandbox.module.exports;
        check("index.js 可解析且导出类", typeof PluginClass === "function");
    } catch (err) {
        check("index.js 可解析", false, err.message);
        process.exit(1);
    }
}

console.log("2) 生命周期");
const p = await newPlugin();
check("onload 不抛错", true);
check("注册了 1 个命令", p.commands.length === 1, `实际 ${p.commands.length}`);
check("命令回调存在", typeof p.commands[0]?.callback === "function");
check(
    "未设默认快捷键（规避 DevTools ⌥⌘I/J/C 与其他插件冲突）",
    !p.commands[0]?.hotkey,
    String(p.commands[0]?.hotkey)
);
check(
    "若日后加回快捷键，不得用 DevTools 三键",
    !["⌥⌘I", "⌥⌘J", "⌥⌘C"].includes(p.commands[0]?.hotkey)
);
check("注册了顶栏按钮", p.topBars.length === 1);
check("注册了图标 symbol（1 次 addIcons）", p.symbols.length === 1);
check("注册了面包屑按钮", p.breadcrumbBtns.length === 1);

console.log("3) 名称字段与文件名");
check("ebook 标题取 trackName", p.itemTitle(EBOOK_ITEM) === "三体", p.itemTitle(EBOOK_ITEM));
check(
    "album 标题取 collectionName（不能是 undefined）",
    p.itemTitle(ALBUM_ITEM) === "范特西",
    p.itemTitle(ALBUM_ITEM)
);
check("tvSeason 标题取 collectionName", p.itemTitle(TV_ITEM) === "三体 第一季", p.itemTitle(TV_ITEM));
check("coverUrl 100x100bb → 3000x3000bb", p.coverUrl(EBOOK_ITEM) === mkCover(101).replace("100x100bb", "3000x3000bb"), p.coverUrl(EBOOK_ITEM));
check(
    "safeName 去掉非法字符",
    p.safeName({ trackName: 'A/B:C*D?"E<F>G|H', __nameKey: "trackName" }) === "ABCDEFGH",
    p.safeName({ trackName: 'A/B:C*D?"E<F>G|H', __nameKey: "trackName" })
);
check(
    "safeName 限长 32",
    p.safeName({ trackName: "字".repeat(50), __nameKey: "trackName" }).length === 32
);
check("safeName 空标题兜底 cover", p.safeName({ trackName: "***", __nameKey: "trackName" }) === "cover");
check("fileNameOf 带 trackId 且为 jpg", p.fileNameOf(EBOOK_ITEM) === "三体-101.jpg", p.fileNameOf(EBOOK_ITEM));

console.log("4) 文档 id 与界面刷新");
check("activeDocId 取自 getAllEditor", p.activeDocId() === DOC_ID, p.activeDocId());
check("protyleOf 能按 id 找到实例", p.protyleOf(DOC_ID) === fakeProtyle);
check("找不到时返回 null", p.protyleOf("nonexistent") === null);
iconRefreshed = null;
const refreshed = p.refreshTitleIcon(DOC_ID, "iTunes-covers/三体-101.jpg");
check("refreshTitleIcon 返回 true", refreshed === true);
check("刷新后 ial.icon 已更新", fakeProtyle.background.ial.icon === "iTunes-covers/三体-101.jpg");
check("图标值同步到了标签页", iconRefreshed === "iTunes-covers/三体-101.jpg", String(iconRefreshed));

console.log("5) iTunes 搜索参数");
reset();
const all = await p.searchItunes("三体", "all");
check("「全部」并发 3 个请求", searchCalls.length === 3, `实际 ${searchCalls.length}`);
check(
    "entity 分别是 ebook/album/tvSeason",
    JSON.stringify(searchCalls.map((c) => c.entity)) === JSON.stringify(["ebook", "album", "tvSeason"]),
    searchCalls.map((c) => c.entity).join(",")
);
check("「全部」每个请求 limit=12", searchCalls.every((c) => c.limit === "12"));
check("country 固定为 us", searchCalls.every((c) => c.country === "us"));
check(
    "中文 term 已编码",
    searchCalls[0].url.includes("term=%E4%B8%89%E4%BD%93") && !searchCalls[0].url.includes("term=三体"),
    searchCalls[0].url
);
check("解码后 term 正确", searchCalls.every((c) => c.term === "三体"));
check("结果按 entity 顺序合并", JSON.stringify(all.map((r) => r.__entity)) === JSON.stringify(["ebook", "ebook", "album", "tvSeason"]), all.map((r) => r.__entity).join(","));
check("无 artwork 的结果被过滤", all.length === 4, `实际 ${all.length}`);
check("结果带 __label / __nameKey", all[0].__label === "typeBook" && all[0].__nameKey === "trackName");

reset();
const albums = await p.searchItunes("周杰伦", "album");
check("单 chip 只发 1 个请求", searchCalls.length === 1, `实际 ${searchCalls.length}`);
check("chip 切换改写 entity 参数", searchCalls[0].entity === "album" && searchCalls[0].url.includes("entity=album"));
check("单 entity limit=36", searchCalls[0].limit === "36");
check("专辑结果 1 条", albums.length === 1 && albums[0].__entity === "album");

reset();
failEntity = "album";
const partial = await p.searchItunes("三体", "all");
check("单个 entity 失败不拖垮整体（仍发 3 个请求）", searchCalls.length === 3);
check("失败的被丢弃，成功的保留", partial.length === 3, `实际 ${partial.length}`);

reset();
failAll = true;
let threw = false;
try {
    await p.searchItunes("三体", "all");
} catch {
    threw = true;
}
check("全部失败才抛错", threw);

console.log("5.5) 搜索超时与中断");
reset();
const liveCtl = new AbortController();
const withSignal = await p.searchItunes("周杰伦", "album", liveCtl.signal);
check("传入进行中的 signal 正常搜索", withSignal.length === 1 && withSignal[0].__entity === "album");
check("signal 分支不发多余请求", searchCalls.length === 1, `实际 ${searchCalls.length}`);

reset();
const deadCtl = new AbortController();
deadCtl.abort(new Error("superseded"));
let aborted = false;
try {
    await p.searchItunes("三体", "album", deadCtl.signal);
} catch (e) {
    aborted = e.message === "superseded";
}
check("外部 signal 已中止时立即失败，不发请求", aborted && searchCalls.length === 0,
    `aborted=${aborted} calls=${searchCalls.length}`);

console.log("6) 图标流水线（materialize → putFile）");
reset();
const iconVal = await p.materialize(EBOOK_ITEM);
check("返回 <组>/<文件> 格式", iconVal === "iTunes-covers/三体-101.jpg", iconVal);
check("目录不存在时先建 .keep 再写文件", JSON.stringify(putFileCalls.map((c) => c.name)) === JSON.stringify([".keep", "三体-101.jpg"]), putFileCalls.map((c) => c.name).join(","));
check("putFile 写入 /data/emojis/iTunes-covers/", putFileCalls[1].path === "/data/emojis/iTunes-covers/三体-101.jpg", putFileCalls[1].path);
check("封面只下载了一次", mzstaticCalls === 1, `实际 ${mzstaticCalls}`);

reset();
groupDirExists = true;
emojiFiles.add("三体-101.jpg");
const iconVal2 = await p.materialize(EBOOK_ITEM);
check("表情组已有同名文件时跳过下载", iconVal2 === "iTunes-covers/三体-101.jpg" && mzstaticCalls === 0 && putFileCalls.length === 0);

console.log("7) 插图流水线（ensureAsset → upload）");
reset();
const assetPath = await p.ensureAsset(EBOOK_ITEM);
check("assetsDirPath 带结尾斜杠", uploadCalls[0]?.dir === "/assets/iTunes-covers/", uploadCalls[0]?.dir);
check("上传文件名为安全 jpg 名", uploadCalls[0]?.name === "三体-101.jpg", uploadCalls[0]?.name);
check("返回 /assets/ 路径", assetPath === "/assets/iTunes-covers/三体-101.jpg", assetPath);
await p.ensureAsset(EBOOK_ITEM);
check("同一封面重复插入不重复上传（Map 缓存）", uploadCalls.length === 1, `实际 ${uploadCalls.length}`);

console.log("8) HTML 转义");
check("转义 <script>", p.esc("<script>") === "&lt;script&gt;");
check("转义引号", p.esc('a"b') === "a&quot;b");
check("null 安全", p.esc(null) === "");

console.log("9) i18n key 集合一致");
const zh = JSON.parse(fs.readFileSync(path.join(root, "i18n", "zh_CN.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(root, "i18n", "en_US.json"), "utf8"));
const SPEC_KEYS = [
    "topbarTitle", "menuOpen", "openPicker", "pickerTitle", "searchPlaceholder",
    "typeAll", "typeBook", "typeAlbum", "typeTv", "hint", "countResult",
    "searching", "noResult", "emptyKeyword", "searchFailed", "noBlock",
    "insertBody", "setAsDocIcon", "inserted", "insertFailed", "applied", "applyFailed",
];
check("zh_CN / en_US key 集合完全一致",
    JSON.stringify(Object.keys(zh).sort()) === JSON.stringify(Object.keys(en).sort()),
    Object.keys(zh).join(",") + " vs " + Object.keys(en).join(","));
check("包含需求文档要求的全部 key", SPEC_KEYS.every((k) => k in zh && k in en),
    SPEC_KEYS.filter((k) => !(k in zh && k in en)).join(","));
check("占位符用 $1（countResult / inserted）", zh.countResult.includes("$1") && zh.inserted.includes("$1"));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
