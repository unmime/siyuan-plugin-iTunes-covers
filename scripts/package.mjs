#!/usr/bin/env node
/**
 * 打包 package.zip —— 供思源市场发布或本地安装使用。
 *
 * 包含：plugin.json / index.js / index.css / i18n / icon.png / preview.png
 *       README*.md / LICENSE
 * 排除：scripts / node_modules / .git / *.zip
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "package.zip");
const name = path.basename(root);

const INCLUDE = [
    "plugin.json",
    "index.js",
    "index.css",
    "i18n",
    "icon.png",
    "preview.png",
    "README.md",
    "README_zh_CN.md",
    "LICENSE",
];

const missing = INCLUDE.filter((f) => !fs.existsSync(path.join(root, f)));
if (missing.includes("index.js") || missing.includes("plugin.json")) {
    console.error(`缺少必要文件：${missing.join(", ")}`);
    process.exit(1);
}
if (missing.length) console.warn(`跳过不存在的文件：${missing.join(", ")}`);

// 校验 plugin.json 关键字段
const conf = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
const required = ["name", "author", "url", "version", "minAppVersion", "displayName", "description"];
const lack = required.filter((k) => !conf[k]);
if (lack.length) {
    console.error(`plugin.json 缺少字段：${lack.join(", ")}`);
    process.exit(1);
}
// name 必须与目录名逐字一致（iTunes 的 T 大写，Linux 上大小写敏感）
if (conf.name !== name) {
    console.error(`plugin.json 的 name (${conf.name}) 必须与目录名 (${name}) 一致`);
    process.exit(1);
}
for (const key of ["icon", "preview"]) {
    if (!conf[key]) continue;
    const p = path.join(root, conf[key]);
    if (!fs.existsSync(p)) {
        console.error(`plugin.json 声明的 ${key} 文件不存在：${conf[key]}`);
        process.exit(1);
    }
    const kb = fs.statSync(p).size / 1024;
    const limit = key === "icon" ? 64 : 512;
    if (kb > limit) {
        console.error(`${conf[key]} 体积 ${kb.toFixed(0)}KB 超过上限 ${limit}KB`);
        process.exit(1);
    }
}

if (fs.existsSync(out)) fs.rmSync(out);

const files = INCLUDE.filter((f) => fs.existsSync(path.join(root, f)));
execSync(`zip -r -q -X "${out}" ${files.map((f) => `"${f}"`).join(" ")}`, {
    cwd: root,
    stdio: "inherit",
});

const kb = fs.statSync(out).size / 1024;
const count = execSync(`unzip -l "${out}" | tail -1`, { encoding: "utf8" }).trim();
console.log(`package.zip  ${kb.toFixed(0)} KB`);
console.log(count);
