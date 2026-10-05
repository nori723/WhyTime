/* WhyTime 最小回归测试：站点名单清洗 + 匹配 + 主机边界。
 * 运行：node tests/test-sites.js （无第三方依赖）
 *
 * Part 1：清洗链路 —— 用户输入脏数据 → 修复前/后链路的行为对照（根因证据）。
 * Part 2：WhyTime 匹配语义 —— 子域恒覆盖 + 主机边界（防伪域名），§17 断言。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

// 在当前上下文执行 common.js / wt-util.js，函数成为全局可直接调用
vm.runInThisContext(fs.readFileSync(path.join(ROOT, "common.js"), "utf8"), { filename: "common.js" });
vm.runInThisContext(fs.readFileSync(path.join(ROOT, "wt-util.js"), "utf8"), { filename: "wt-util.js" });

const URL_MAIN = "https://www.bilibili.com/";
const URL_SUB = "https://space.bilibili.com/";

let failures = 0;
function check(name, actual, expect) {
	const ok = (actual === expect);
	if (!ok) failures++;
	console.log("  " + (ok ? "PASS" : "FAIL") + "  " + name
			+ (ok ? "" : "  (got " + actual + ", want " + expect + ")"));
	return ok;
}

/* ---------------- Part 1: 清洗链路（根因证据） ---------------- */

console.log("Part 1: 清洗链路（old-chain = 脏值直进引擎，new-chain = sanitize 后）");
console.log("case".padEnd(22), "expect", "old-chain", "new-chain");
console.log("-".repeat(58));

// [名称, 用户输入, 期望主站]（子域恒覆盖由 Part 2 单独断言）
const CASES = [
	["plain",               "bilibili.com", true, false],
	["leading space",       " bilibili.com", true, false],
	["trailing space",      "bilibili.com ", true, false],
	["both sides space",    " bilibili.com ", true, false],
	["tab/newline mix",     "\t\n bilibili.com \n\t", true, false],
	["multi-line mixed ws", " bilibili.com \n\n  youtube.com\n zhihu.com ", true, false],
	["full-width space",    "bilibili.com\u3000", true, false],
	["NBSP",                "bilibili.com\u00A0", true, false],
	["zero-width U+200B",   "bilibili.com\u200B", true, false],
	["zero-width U+2060",   "bilibili.com\u2060", true, false],
	["full-width letters",  "\uFF42\uFF49\uFF4C\uFF49\uFF42\uFF49\uFF4C\uFF49.com", true, false],
	["uppercase",           "BILIBILI.COM", true, false],
	["LBNG allow prefix",   "+bilibili.com", true, false],
];

vm.runInThisContext(`
	function __oldChain(sites, sub) {
		// 修复前：脏值直接进 cleanSites → getRegExpSites
		const re = getRegExpSites(cleanSites(sites), sub).block;
		return {
			main: !!re && (new RegExp(re, "i")).test(${JSON.stringify(URL_MAIN)}),
			sub:  !!re && (new RegExp(re, "i")).test(${JSON.stringify(URL_SUB)})
		};
	}
	function __newChain(raw) {
		// 修复后：options 保存路径 = sanitizeSiteInput → cleanSites → urlMatchesSiteList
		const saved = cleanSites(sanitizeSiteInput(raw).sites.join(" "), true);
		return {
			main: urlMatchesSiteList(${JSON.stringify(URL_MAIN)}, saved),
			sub:  urlMatchesSiteList(${JSON.stringify(URL_SUB)}, saved)
		};
	}
`);

for (const [name, raw, expectMain] of CASES) {
	const oldR = __oldChain(raw, false);
	const newR = __newChain(raw);
	// 注：子域（space.bilibili.com）在 WhyTime 语义下恒为匹配，由 Part 2 断言，
	// 这里只对主站断言，保持根因证据表的焦点。
	const oldOK = (oldR.main === expectMain);
	const newOK = (newR.main === expectMain);
	if (!newOK) failures++;
	console.log(
		name.padEnd(22),
		"main=" + expectMain,
		oldOK ? "PASS" : "FAIL ",
		newOK ? "PASS" : "FAIL ",
		(!oldOK ? "  <- old-chain failed: main=" + oldR.main : "")
	);
}

/* ---------------- Part 2: 子域覆盖 + 主机边界（§17 断言） ---------------- */

console.log("\nPart 2: 子域恒覆盖 + 主机边界（名单 = bilibili.com）");
console.log("-".repeat(58));

vm.runInThisContext(`
	// 引擎原始输出（无边界断言）——用来证明为什么必须追加 lookahead
	function __enginePlain(url) {
		const re = getRegExpSites(cleanSites("bilibili.com"), true).block;
		return !!re && (new RegExp(re, "i")).test(url);
	}
`);

console.log("  urlMatchesSiteList（完整 URL → 名单）:");
check("https://www.bilibili.com/",
		urlMatchesSiteList("https://www.bilibili.com/", "bilibili.com"), true);
check("https://message.bilibili.com/",
		urlMatchesSiteList("https://message.bilibili.com/", "bilibili.com"), true);
check("https://space.bilibili.com/",
		urlMatchesSiteList("https://space.bilibili.com/", "bilibili.com"), true);
check("https://space.bilibili.com/71307664（带路径）",
		urlMatchesSiteList("https://space.bilibili.com/71307664", "bilibili.com"), true);
check("https://passport.bilibili.com/",
		urlMatchesSiteList("https://passport.bilibili.com/", "bilibili.com"), true);
check("https://www.bilibili.com/video/xxx",
		urlMatchesSiteList("https://www.bilibili.com/video/xxx", "bilibili.com"), true);
check("https://bilibili.com（无路径）",
		urlMatchesSiteList("https://bilibili.com", "bilibili.com"), true);

console.log("  不得匹配:");
check("https://notbilibili.com/",
		urlMatchesSiteList("https://notbilibili.com/", "bilibili.com"), false);
check("https://bilibili.com.example.com/",
		urlMatchesSiteList("https://bilibili.com.example.com/", "bilibili.com"), false);
check("https://fakebilibili.example.com/",
		urlMatchesSiteList("https://fakebilibili.example.com/", "bilibili.com"), false);

console.log("  hostMatchesSite（Session 归属判定）:");
for (const h of ["bilibili.com", "www.bilibili.com", "message.bilibili.com",
		"space.bilibili.com", "passport.bilibili.com"]) {
	check("  host " + h, hostMatchesSite(h, "bilibili.com"), true);
}
check("  host notbilibili.com", hostMatchesSite("notbilibili.com", "bilibili.com"), false);
check("  host bilibili.com.example.com",
		hostMatchesSite("bilibili.com.example.com", "bilibili.com"), false);
check("  host google.com", hostMatchesSite("google.com", "bilibili.com"), false);

console.log("  证据：引擎原始正则（无边界断言）会误放行 bilibili.com.example.com:");
check("  engine-plain bilibili.com.example.com",
		__enginePlain("https://bilibili.com.example.com/"), true);

/* ---------------- Part 3: 关键词条目（不含点号） ---------------- */

console.log("\nPart 3: 关键词条目 —— 主机名包含即命中（v0.9 语义）");
console.log("-".repeat(58));

console.log("  hostMatchesSite（关键词 = bilibili）:");
check("  www.bilibili.com", hostMatchesSite("www.bilibili.com", "bilibili"), true);
check("  space.bilibili.com", hostMatchesSite("space.bilibili.com", "bilibili"), true);
check("  bilibili.tv（任意后缀）", hostMatchesSite("bilibili.tv", "bilibili"), true);
check("  bilibili（裸主机）", hostMatchesSite("bilibili", "bilibili"), true);
// 关键词语义的固有宽松性：含词域名也算（与域名模式不同，记录在案）
check("  notbilibili.com（关键词语义下命中）",
		hostMatchesSite("notbilibili.com", "bilibili"), true);
check("  google.com 不含词", hostMatchesSite("google.com", "bilibili"), false);

console.log("  siteListMatches（组合匹配：域名条目 + 关键词条目混用）:");
check("  名单=bilibili → www.bilibili.com 命中",
		siteListMatches("https://www.bilibili.com/", "www.bilibili.com", "bilibili"), true);
check("  名单=bilibili → 路径含词不算、主机不含词不命中",
		siteListMatches("https://www.google.com/search?q=bilibili", "www.google.com", "bilibili"), false);
check("  名单=bilibili\\nweibo → weibo.com 命中",
		siteListMatches("https://weibo.com/", "weibo.com", "bilibili\nweibo"), true);
check("  混合名单：域名条目仍边界安全（notbilibili 不因 bilibili.com 命中）",
		siteListMatches("https://notbilibili.com/", "notbilibili.com", "bilibili.com\nweibo"), false);
check("  混合名单：关键词条目命中 s.weibo.cn",
		siteListMatches("https://s.weibo.cn/weibo?q=1", "s.weibo.cn", "bilibili.com\nweibo"), true);

console.log("  大小写归一（2026-10-03 用户报告 YouTube 不生效）:");
check("  输入 YouTube → sanitize 后小写",
		sanitizeSiteInput("YouTube").sites.join(","), "youtube");
check("  matchConfiguredSite 大写条目返回小写",
		matchConfiguredSite("www.youtube.com", ["YouTube"]), "youtube");
check("  hostMatchesSite 大写条目命中",
		hostMatchesSite("www.youtube.com", "YouTube"), true);

/* ---------------- 汇总 ---------------- */

console.log("-".repeat(58));
if (failures === 0) {
	console.log("ALL PASS");
} else {
	console.log("FAILURES: " + failures);
	process.exit(1);
}
