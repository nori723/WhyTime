/* WhyTime 生命周期诊断测试（Phase 1.4：blocked.html 阻断架构）。
 * 运行：node tests/test-flow.js （无第三方依赖）
 *
 * Part A  静态诊断 —— manifest、文件存在、importScripts、命名冲突、依赖可用性。
 * Part B  真实 background.js + mock chrome（含 tabs.update 记录）：
 *         hello 判定 → ctx 签发 → blocked.html 上下文兑换 → 承诺 → 放行 →
 *         到期 → 续时 → 上限 → 结束 → 重新开始，以及 §7 的绕过/伪造断言。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let failures = 0;
function check(name, actual, expect) {
	const ok = (actual === expect);
	if (!ok) failures++;
	console.log("  " + (ok ? "PASS" : "FAIL") + "  " + name
			+ (ok ? "" : "  (got " + JSON.stringify(actual) + ", want " + JSON.stringify(expect) + ")"));
	return ok;
}

/* ---------------- Part A: 静态诊断 ---------------- */

console.log("Part A: manifest / 文件 / 命名冲突 / 依赖可用性");
console.log("-".repeat(66));

const manifest = JSON.parse(read("manifest.json"));

check("manifest version 0.16.1", manifest.version, "0.16.1");
check("扩展名已改为 WhyTime（2026-10-03 用户决定）", manifest.name, "WhyTime");
check("工具栏标题同步", manifest.action && manifest.action.default_title, "WhyTime");
check("manifest 图标四档齐全",
		JSON.stringify(Object.keys(manifest.icons || {})), JSON.stringify(["16", "32", "48", "128"]));
check("action 工具栏图标", !!(manifest.action && manifest.action.default_icon), true);
for (const s of ["16", "32", "48", "128"]) {
	check("图标文件存在: icon" + s + ".png", fs.existsSync(path.join(ROOT, "icons", "icon" + s + ".png")), true);
}
const cs = manifest.content_scripts[0];
check("脚本顺序 common→wt-util→content",
		JSON.stringify(cs.js), JSON.stringify(["common.js", "wt-util.js", "content.js"]));
check("run_at document_start", cs.run_at, "document_start");
check("matches 含 <all_urls>", cs.matches.indexOf("<all_urls>") >= 0, true);
check("权限未扩大", JSON.stringify(manifest.permissions), JSON.stringify(["alarms", "storage"]));
for (const f of [...cs.js, "background.js", "blocked.html", "blocked.css", "blocked.js",
		"history.html", "history.css", "history.js", "wt-stats.js"]) {
	check("文件存在: " + f, fs.existsSync(path.join(ROOT, f)), true);
}

const bgSrc = read("background.js");
const importTargets = [...bgSrc.matchAll(/importScripts\("([^"]+)"\)/g)].map((m) => m[1]);
check("background importScripts 顺序",
		JSON.stringify(importTargets), JSON.stringify(["common.js", "wt-util.js", "wt-stats.js"]));

function topLevelNames(src) {
	const names = new Set();
	for (const m of src.matchAll(/^(?:async[ \t]+)?function[ \t]+(\w+)/gm)) names.add(m[1]);
	for (const m of src.matchAll(/^(?:const|let|var)[ \t]+(\w+)/gm)) names.add(m[1]);
	return names;
}
const nameSets = {
	"common.js": topLevelNames(read("common.js")),
	"wt-util.js": topLevelNames(read("wt-util.js")),
	"wt-stats.js": topLevelNames(read("wt-stats.js")),
	"content.js": topLevelNames(read("content.js")),
	"background.js": topLevelNames(bgSrc)
};
const sharedWorlds = [
	["common.js", "wt-util.js", "content.js"],                 // content world
	["common.js", "wt-util.js", "wt-stats.js", "background.js"] // service worker world
];
for (const group of sharedWorlds) {
	for (let i = 0; i < group.length; i++) {
		for (let j = i + 1; j < group.length; j++) {
			const dup = [...nameSets[group[i]]].filter((n) => nameSets[group[j]].has(n));
			check("无顶层命名冲突: " + group[i] + " × " + group[j], dup.length, 0);
		}
	}
}
const swProvided = new Set([...nameSets["common.js"], ...nameSets["wt-util.js"], ...nameSets["wt-stats.js"]]);
for (const fn of ["sanitizeSiteInput", "urlMatchesSiteList", "hostMatchesSite",
		"getParsedURL", "getCleanURL", "cleanSites", "getRegExpSites",
		"resolveSettings", "defaultSettings", "DEFAULT_SITES",
		"splitUsageByDay", "buildDailyReport", "buildOverview",
		"historyToJSON", "historyToCSV"]) {
	check("SW 作用域可用: " + fn, swProvided.has(fn), true);
}

// §17：Continue 的时长选择必须与 Gate 区分——只有 +5/+10/+20，无自定义输入
const blockedSrc = read("blocked.js");
check("Continue 快捷档 = [5,10,20]",
		/blocked[\s\S]*?const EXTEND_CHOICES = \[5, 10, 20\];/.test(blockedSrc), true);
check("Continue 按钮带 + 号（+N 分钟）", blockedSrc.indexOf("+${d} 分钟") !== -1, true);
// customMinutes 只属于 Gate：Expired/Promise 模板函数体内不得出现
const expiredFnStart = blockedSrc.indexOf("function expiredHTML");
const expiredFnEnd = blockedSrc.indexOf("\nfunction ", expiredFnStart + 1);
check("自定义时长输入不进入 Continue 表单",
		blockedSrc.slice(expiredFnStart, expiredFnEnd).indexOf("customMinutes") === -1, true);

// Gate 原因【复制】按钮：存在于 Gate 模板、不进入 Expired/Promise 表单、空原因禁用、带剪贴板回退
check("Gate 原因复制按钮存在于模板",
		blockedSrc.indexOf('id="copyReasonBtn"') !== -1, true);
check("复制按钮不进入 Continue 表单",
		blockedSrc.slice(expiredFnStart, expiredFnEnd).indexOf("copyReasonBtn") === -1, true);
check("复制按钮空原因禁用（update 内）",
		/copyBtn\.disabled = !state\.reason\.trim\(\)/.test(blockedSrc), true);
check("复制带 execCommand 回退", blockedSrc.indexOf("execCommand") !== -1, true);
// v0.11.0 对抗"预算授予感"：Gate 引导短预算 + Ended 显示省下的时间
check("Gate 预算引导语存在", blockedSrc.indexOf("拿不准就选短的") !== -1, true);
check("Ended 省时文案存在", blockedSrc.indexOf("比计划提前了") !== -1, true);
check("结束路径回传省下的分钟数（background）", bgSrc.indexOf("savedMin") !== -1, true);

// v0.9.5 视觉：blocked.css 必须保留四状态共用的全部既有选择器（JS 模板依赖）
const blockedCss = read("blocked.css");

// v0.14 替代动作与续命摩擦
check("Ended 正反馈句存在", blockedSrc.indexOf("你停下来了。这比继续难。") !== -1, true);
check("Ended/Expired 随机替代盒存在", blockedSrc.indexOf("function pickAlt") !== -1
		&& blockedSrc.indexOf("alt-box") !== -1, true);
check("Expired 承诺表单带替代入口与前理由展示",
		blockedSrc.indexOf("altInlineHTML(pickAlt(alt))") !== -1
		&& blockedSrc.indexOf("前几次的理由") !== -1, true);
check("确认继续 15 秒冷却", blockedSrc.indexOf("再等 ") !== -1
		&& blockedCss.indexOf(".alt-box") !== -1, true);
check("SW 重复理由拒绝", bgSrc.indexOf("换个理由试试") !== -1
		&& bgSrc.indexOf("whytime.recentReasons") !== -1, true);
check("background 下发 altList", bgSrc.indexOf("parseAlt(settings)") !== -1, true);
for (const sel of [".wt-page", ".wt-header", ".wt-brand", ".wt-today", ".wt-footer", ".wt-motto",
		".state-head", ".state-sub", ".fact", ".chips", ".chip", ".chip.on", "textarea",
		".custom-duration", ".end-hint", ".label-row", ".copy-btn", ".btn-primary", ".btn-secondary",
		".btn-row", ".btn-danger", ".btn-danger-solid", ".error-line", ".promise-box", ".limit-note",
		".encourage", ".hidden", ".wt-loading"]) {
	check("blocked.css 保留选择器: " + sel, blockedCss.indexOf(sel) !== -1, true);
}
// v0.9.9 视觉定稿：Flow 式实心白卡 + Manrope 可变字体——半透明玻璃导致画面
// 发蒙、没有重点（v0.9.5–0.9.8 教训），卡片回归实心，层级靠字重拉开
check("卡片为实心白（无 backdrop-filter 玻璃）",
		/\.wt-page\s*{[^}]*background:\s*#ffffff/.test(blockedCss)
		&& blockedCss.indexOf("backdrop-filter") === -1, true);
check("Flow light 同款细描边", blockedCss.indexOf("#e2e8f0") !== -1, true);
check("Manrope 可变字体声明（200-800）",
		/@font-face[\s\S]{0,200}Manrope[\s\S]{0,200}font-weight:\s*200 800/.test(blockedCss), true);
check("字体栈含 Manrope", /font:[^;]*"Manrope"/.test(blockedCss), true);
check("字体文件入库", fs.existsSync(path.join(ROOT, "fonts", "manrope.woff2")), true);
check("Manrope 许可文件随附", fs.existsSync(path.join(ROOT, "fonts", "MANROPE-LICENSE.txt")), true);
check("层级靠字重：h1 800 / 按钮 700",
		/h1\s*{[^}]*font-weight:\s*800/.test(blockedCss)
		&& /\.btn-primary\s*{[^}]*font-weight:\s*700/.test(blockedCss), true);
check("清新绿渐变主按钮", /linear-gradient\(135deg,\s*var\(--green-1\),\s*var\(--green-2\)\)/.test(blockedCss), true);
check("悬停微交互：主按钮上浮", /btn-primary:hover:not\(:disabled\)[\s\S]{0,200}translateY\(-1px\) scale\(1\.01\)/.test(blockedCss), true);
check("尊重 prefers-reduced-motion", blockedCss.indexOf("prefers-reduced-motion") !== -1, true);

/* ---------------- Part A2: wt-stats 纯函数（日报 / 导出 / 跨午夜） ---------------- */

vm.runInThisContext(read("common.js"), { filename: "common.js" });
vm.runInThisContext(read("wt-util.js"), { filename: "wt-util.js" });
vm.runInThisContext(read("wt-stats.js"), { filename: "wt-stats.js" });

console.log("\nPart A2: wt-stats 纯函数");
console.log("-".repeat(66));
{
	const noon = new Date(); noon.setHours(12, 0, 0, 0);
	const T0 = noon.getTime();
	const sess = [
		{ id: "s1", site: "bilibili.com", startTime: T0, endTime: T0 + 20 * 60000,
			plannedSeconds: 1200, actualSeconds: 1200, purpose: "学习", reason: "查,教程",
			extensionCount: 1, endKind: "user", status: "ended" },
		{ id: "s2", site: "zhihu.com", startTime: T0, endTime: T0 + 10 * 60000,
			plannedSeconds: 600, actualSeconds: 600, purpose: "学习", reason: "查资料",
			extensionCount: 0, endKind: "expiry", status: "ended" }
	];
	const drep = buildDailyReport(sess, dayKey(T0));
	check("日报 网站数", drep.sites.length, 2);
	check("日报 实际合计 = 30 分钟", drep.actualSecs, 1800);
	check("日报 计划合计 = 30 分钟", drep.plannedSecs, 1800);
	check("日报 打开次数", drep.sessionCount, 2);
	check("日报 续时次数", drep.extensionCount, 1);
	check("日报 发生续时的 Session 数", drep.extendedSessions, 1);

	// 跨午夜：昨日 23:55 → 今日 00:10
	const midnight = new Date(noon); midnight.setHours(0, 0, 0, 0);
	const midMs = midnight.getTime();
	const cross = { id: "s3", site: "bilibili.com", startTime: midMs - 5 * 60000,
		endTime: midMs + 10 * 60000, plannedSeconds: 900, actualSeconds: 900,
		purpose: "娱乐", reason: "跨夜", extensionCount: 0, endKind: "expiry", status: "ended" };
	const cToday = buildDailyReport([cross], dayKey(midMs));
	const cYest = buildDailyReport([cross], dayKey(midMs - 86400000));
	check("跨午夜：今日段 = 10 分钟", cToday.actualSecs, 600);
	check("跨午夜：昨日段 = 5 分钟", cYest.actualSecs, 300);
	check("跨午夜：计划归开始日（昨日）", cYest.plannedSecs, 900);
	check("跨午夜：今日计划不含昨日开始的 Session", cToday.plannedSecs, 0);

	// 导出
	const j = historyToJSON(sess, "2026-10-03T00:00:00Z");
	check("JSON 信封 kind", j.kind, "whytime-history");
	check("JSON 保留完整字段（含逗号 reason）", j.sessions[0].reason, "查,教程");
	check("JSON 附 ISO 时间", typeof j.sessions[0].startISO, "string");
	check("JSON 可回读", JSON.parse(JSON.stringify(j)).sessions.length, 2);
	const csv = historyToCSV(sess);
	check("CSV 带 UTF-8 BOM", csv.charCodeAt(0), 0xFEFF);
	check("CSV 表头（BOM 之后）",
			csv.replace(/^\uFEFF/, "").split("\r\n")[0].indexOf("id,site,start") === 0, true);
	check("CSV 逗号/中文正确转义", csv.indexOf('"查,教程"') !== -1, true);
	check("CSV 行数 = 表头 + 2", csv.replace(/\r\n$/, "").split("\r\n").length, 3);
	check("空历史 CSV 仅表头", historyToCSV([]).replace(/^\uFEFF/, "").trim().split("\r\n").length, 1);
	check("空历史 JSON", historyToJSON([], "x").sessions.length, 0);

	// v0.16 宵禁窗口纯函数
	const S = { curfewStart: "22:00", curfewEnd: "06:00" };
	const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
	check("宵禁 23:00 命中", inCurfewWindow(S, at(23, 0)), true);
	check("宵禁 03:00 命中（跨午夜）", inCurfewWindow(S, at(3, 0)), true);
	check("宵禁 12:00 不命中", inCurfewWindow(S, at(12, 0)), false);
	check("宵禁 21:59 不命中 / 22:00 命中", inCurfewWindow(S, at(21, 59)), false);
	check("宵禁 06:00 解除", inCurfewWindow(S, at(6, 0)), false);
	check("宵禁 start===end = 关闭", inCurfewWindow({ curfewStart: "22:00", curfewEnd: "22:00" }, at(23, 0)), false);
	check("宵禁 同日窗口 12:00-18:00 命中 15:00",
			inCurfewWindow({ curfewStart: "12:00", curfewEnd: "18:00" }, at(15, 0)), true);
}

/* ---------------- Part B: SW 生命周期诊断链 ---------------- */

console.log("\nPart B: 真实 background.js + mock chrome（含 tabs.update 记录）");
console.log("-".repeat(66));

function boot(storageMap) {
	// 套件不跟随墙钟：默认关掉宵禁（start===end 即关闭）。默认设置自带
	// 22:00–06:00 宵禁，夜间运行会让 gate/start-session 集体命中 sleep
	// 路径；只有显式传入 curfewStart 的场景才保留自己的窗口。
	const seeded = storageMap["whytime.settings"];
	if (seeded && seeded.curfewStart == null) {
		seeded.curfewStart = "00:00";
		seeded.curfewEnd = "00:00";
	}
	const listeners = { message: null, installed: null, alarm: null, updates: [], sent: [], alarms: [] };
	const chrome = {
		storage: {
			local: {
				get: async (key) => {
					const keys = Array.isArray(key) ? key : [key];
					const out = {};
					for (const k of keys) {
						if (Object.prototype.hasOwnProperty.call(storageMap, k)) out[k] = storageMap[k];
					}
					return out;
				},
				set: async (obj) => { Object.assign(storageMap, JSON.parse(JSON.stringify(obj))); },
				remove: async (k) => { delete storageMap[k]; }
			}
		},
		alarms: {
			create: (a, b) => { listeners.alarms.push({ name: a, info: b }); },
			clear: () => {},
			onAlarm: { addListener: (f) => { listeners.alarm = f; } }
		},
		tabs: {
			query: async (q) => (q && q.active && q.lastFocusedWindow)
					? [{ id: 1, active: true }] : [],
			update: async (tabId, props) => {
				listeners.updates.push({ tabId: tabId, props: props });
				return {};
			},
			sendMessage: async (tabId, msg) => {
				listeners.sent.push({ tabId: tabId, msg: msg });
				return {};
			}
		},
		runtime: {
			onMessage: { addListener: (f) => { listeners.message = f; } },
			onInstalled: { addListener: (f) => { listeners.installed = f; } },
			onStartup: { addListener: (f) => { listeners.startup = f; } },
			getURL: (p) => "chrome-extension://whytime/" + p
		}
	};
	const ctx = { chrome: chrome, console: console };
	ctx.importScripts = (f) => vm.runInContext(read(f), ctx, { filename: f });
	vm.createContext(ctx);
	vm.runInContext(read("background.js"), ctx, { filename: "background.js" });

	const call = (message, sender) => {
		if (message && message.type === "start-session" && message.nextAction === undefined) {
			message.nextAction = "测试下一步"; // v0.15.1 起必填，旧用例自动补齐
		}
		if (message && (message.type === "start-session" || message.type === "extend-session")
				&& message.perspective === undefined) {
			message.perspective = true; // v0.16 必答，旧用例自动补齐
		}
		return new Promise((resolve) => {
			listeners.message(message, sender, resolve);
		});
	};
	const hello = (url, tabId) => call({ type: "hello", url: url }, { url: url, tab: { id: tabId || 1 } });
	const lastBlockUrl = () => {
		const u = listeners.updates[listeners.updates.length - 1];
		return u ? u.props.url : null;
	};
	const ctxIdFrom = (blockUrl) => new URL(blockUrl).searchParams.get("ctx");

	// 全新安装场景：installed() 写入默认设置（含 22:00–06:00 宵禁），夜间运行
	// 同样会转向 sleep 视图——写完后统一改写为关闭；需要宵禁的场景自行显式设置。
	const origInstalled = listeners.installed;
	if (origInstalled) {
		listeners.installed = async function (ev) {
			await origInstalled(ev);
			const s = storageMap["whytime.settings"];
			if (s && s.curfewStart === "22:00" && s.curfewEnd === "06:00") {
				s.curfewStart = "00:00";
				s.curfewEnd = "00:00";
			}
		};
	}

	return { storageMap, listeners, call, hello, lastBlockUrl, ctxIdFrom, vmctx: ctx };
}

const BILI_WWW = "https://www.bilibili.com/";
const BILI_SPACE = "https://space.bilibili.com/71307664";
const BILI_MSG = "https://message.bilibili.com/";


// 冷却期测试助手：把最近归档 Session 的结束时间拨回 11 分钟前（> 上限 10 分钟）
function backdateLastEnd(storageMap, mins) {
	// 回拨所有晚于阈值的结束时间：语义 = "确保至少 mins 分钟内没有任何结束"，
	// 与冷静期判定（lastEnd + 冷却时长 <= now）完全对应
	const list = storageMap["whytime.sessions"] || [];
	const cutoff = Date.now() - mins * 60000;
	for (const s of list) {
		const end = s.endTime || s.settledAt || 0;
		if (end > cutoff) {
			s.endTime = cutoff;
			if (s.settledAt) s.settledAt = cutoff;
		}
	}
}

async function main() {

	// ---- Scenario R：旧缺陷形态（sites 为空）----
	console.log("\nScenario R: 用户清空名单 → 受限逻辑关闭");
	{
		const app = boot({ "whytime.settings": { sites: "", durations: [5, 10, 20, 30, 45, 60], maxExtensions: 2 } });
		const resp = await app.hello(BILI_WWW);
		check("hello → allow（不拦截）", resp.action, "allow");
	}

	// ---- Scenario F：全新安装 + Gate 上下文 + 绕过/伪造 ----
	console.log("\nScenario F: 全新安装 → hello 拦截 → ctx 签发 → Gate 上下文");
	{
		const app = boot({});
		await app.listeners.installed({ reason: "install" });
		check("onInstalled 写入默认名单", app.storageMap["whytime.settings"].sites, "bilibili.com");
		check("默认替代动作 = 阅读|运动",
				app.storageMap["whytime.settings"].altName, "阅读|运动");
		check("默认替代链接含微信读书",
				(app.storageMap["whytime.settings"].altUrl || "").indexOf("weread.qq.com") !== -1, true);
		check("默认续时次数 = 0（2026-10-03 决策）",
				app.storageMap["whytime.settings"].maxExtensions, 0);

		const resp = await app.hello(BILI_WWW, 1);
		check("hello www.bilibili.com → block", resp.action, "block");
		const blockUrl = app.lastBlockUrl();
		check("tabs.update 前往 blocked.html", /blocked\.html\?ctx=/.test(blockUrl || ""), true);
		check("blockUrl 不泄露 returnUrl", (blockUrl || "").indexOf("returnUrl=") === -1
				&& (blockUrl || "").indexOf("https://") === -1, true);

		const ctxId = app.ctxIdFrom(blockUrl);
		const stored = app.storageMap["whytime.blockCtx"][ctxId];
		check("ctx 登记了可信 returnUrl", stored && stored.returnUrl, BILI_WWW);

		const bc = await app.call({ type: "block-context", ctxId: ctxId }, { url: blockUrl, tab: { id: 1 } });
		check("block-context → view gate", bc.view, "gate");
		check("block-context 下发可信 returnUrl", bc.returnUrl, BILI_WWW);
		check("block-context 下发档位", Array.isArray(bc.durations) && bc.durations.length > 0, true);
		check("档位含 15 分钟（v0.15 新增）", bc.durations.indexOf(15) !== -1, true);

		check("hello space → block（同样拦截）", (await app.hello(BILI_SPACE, 2)).action, "block");
		check("hello message → block", (await app.hello(BILI_MSG, 3)).action, "block");

		const before = app.listeners.updates.length;
		check("hello notbilibili → allow", (await app.hello("https://notbilibili.com/", 4)).action, "allow");
		check("hello bilibili.com.example.com → allow",
				(await app.hello("https://bilibili.com.example.com/", 4)).action, "allow");
		check("伪域名没有触发导航", app.listeners.updates.length, before);

		const bad = await app.call({ type: "block-context", ctxId: "ctx-forged" }, { tab: { id: 9 } });
		check("伪造 ctx → view invalid", bad.view, "invalid");
	}

	// ---- Scenario S：承诺 → Active → 子域连续 → 到期 ----
	console.log("\nScenario S: 承诺 → Active → 子域同 Session → 到期 → Expired 上下文");
	{
		const app = boot({
			"whytime.settings": { sites: "bilibili.com", durations: [5, 10, 20, 30, 45, 60], maxExtensions: 2 }
		});
		await app.listeners.installed({ reason: "install" });
		await app.hello(BILI_WWW, 1);
		const ctxId = app.ctxIdFrom(app.lastBlockUrl());

		const s1 = await app.call({
			type: "start-session", ctxId: ctxId,
			reason: "查 PsychoPy 教程", purpose: "学习", plannedMinutes: 1
		}, { url: "chrome-extension://whytime/blocked.html", tab: { id: 1 } });
		check("start-session → session-started", s1.type, "session-started");
		check("1 分钟预算", s1.session && s1.session.plannedSeconds, 60);
		check("下发可信 returnUrl", s1.returnUrl, BILI_WWW);

		const h1 = await app.hello(BILI_WWW, 1);
		check("hello www → allow+session", h1.action === "allow" && h1.session.status, "active");
		const h2 = await app.hello(BILI_SPACE, 2);
		check("hello space → 同一 Session", h2.action === "allow" && h2.session.id === s1.session.id, true);
		const h3 = await app.hello("https://www.google.com/", 3);
		check("hello google → allow 无 session", h3.action === "allow" && !h3.session, true);

		// 人为让 Session 到期
		app.storageMap["whytime.activeSession"].plannedEndTime = Date.now() - 1000;
		const e1 = await app.call({ type: "expire-check", url: BILI_WWW }, { url: BILI_WWW, tab: { id: 1 } });
		check("expire-check → block（去 blocked.html）", e1.action, "block");
		check("Session 已结算为 expired", app.storageMap["whytime.activeSession"].status, "expired");

		const bc = await app.call({ type: "block-context", ctxId: ctxId }, { tab: { id: 1 } });
		check("block-context → view expired", bc.view, "expired");
		check("expired 视图带 Session 数据", bc.session && bc.session.id === s1.session.id, true);
		check("expired 视图带续时上限", bc.maxExtensions, 2);
		check("settledAt 已写入（到期结算点）",
				typeof app.storageMap["whytime.activeSession"].settledAt === "number", true);
	}

	// ---- Scenario C：二次承诺 → 限额 → 结束 ----
	console.log("\nScenario C: 续时 ×2 → 第 3 次拒绝 → Ended");
	{
		const app = boot({
			"whytime.settings": { sites: "bilibili.com", durations: [5, 10, 20, 30, 45, 60], maxExtensions: 2 }
		});
		await app.listeners.installed({ reason: "install" });
		await app.hello(BILI_WWW, 1);
		const ctxId = app.ctxIdFrom(app.lastBlockUrl());
		await app.call({
			type: "start-session", ctxId: ctxId,
			reason: "开始", purpose: "学习", plannedMinutes: 1,
			nextAction: "去阅读"
		}, { tab: { id: 1 } });
		check("nextAction 已存储", app.storageMap["whytime.activeSession"].nextAction, "去阅读");

		const expire = async () => {
			app.storageMap["whytime.activeSession"].plannedEndTime = Date.now() - 1000;
			await app.call({ type: "expire-check", url: BILI_WWW }, { url: BILI_WWW, tab: { id: 1 } });
		};

		// 续时只发生在 expired 状态（active 时 SW 返回 resume-active，设计如此）
		check("初始继续次数 = 0",
				app.storageMap["whytime.activeSession"].extensionCount, 0);
		await expire();
		let bc0 = await app.call({ type: "block-context", ctxId: ctxId }, { tab: { id: 1 } });
		check("Expired 视图继续次数 0 / 2", bc0.session.extensionCount, 0);
		check("Expired 视图带替代动作列表", Array.isArray(bc0.altList)
				&& bc0.altList.length === 2
				&& bc0.altList[0].name === "阅读", true);
		check("Expired 视图带今日延长次数 0", bc0.todayExtCount, 0);

		const x1 = await app.call({ type: "extend-session", ctxId: ctxId, addMinutes: 10, reason: "资料没查完" }, { tab: { id: 1 } });
		check("第 1 次续时 → active", x1.type, "session-extended");
		check("预算 1+10 分钟", x1.session && x1.session.plannedSeconds, 660);
		check("续时后 extensionCount = 1", x1.session && x1.session.extensionCount, 1);
		check("续时记录含视角作答", x1.session.extensions[0].perspective === true, true);
		check("续时后下发 returnUrl", x1.returnUrl, BILI_WWW);
		check("新的 plannedEndTime 在未来", x1.session && x1.session.plannedEndTime > Date.now(), true);

		// 理由有成本（v0.14）：与最近 3 条相同 → SW 拒绝；状态仍是 expired 可直接重试
		await expire();
		const dup = await app.call({ type: "extend-session", ctxId: ctxId, addMinutes: 5,
			reason: "资料没查完" }, { tab: { id: 1 } });
		check("重复续时理由被 SW 拒绝", dup.type === "error"
				&& dup.message.indexOf("换个理由") !== -1, true);
		check("拒绝后状态仍为 expired",
				app.storageMap["whytime.activeSession"].status, "expired");

		await expire();
		const x2 = await app.call({ type: "extend-session", ctxId: ctxId, addMinutes: 5, reason: "最后一步" }, { tab: { id: 1 } });
		check("第 2 次续时 → active", x2.type, "session-extended");
		check("extensionCount = 2", x2.session && x2.session.extensionCount, 2);

		await expire();
		const x3 = await app.call({ type: "extend-session", ctxId: ctxId, addMinutes: 5, reason: "还想看" }, { tab: { id: 1 } });
		check("第 3 次续时被 SW 拒绝", x3.type, "extend-denied");
		const bcC = await app.call({ type: "block-context", ctxId: ctxId }, { tab: { id: 1 } });
		check("拒绝后继续次数仍为 2 / 2", bcC.session.extensionCount, 2);
		check("到期视图带今日延长次数 2", bcC.todayExtCount, 2);
		check("到期视图带替代动作列表", Array.isArray(bcC.altList) && bcC.altList.length === 2, true);

		const e1 = await app.call({ type: "end-session", ctxId: ctxId }, { tab: { id: 1 } });
		check("end-session → session-ended", e1.type, "session-ended");
		check("ended 响应带今日累计", typeof e1.todaySeconds === "number", true);
		check("到时结束 endKind = expiry", e1.session && e1.session.endKind, "expiry");
		check("到时结束 endTime = settledAt",
				e1.session && e1.session.endTime === e1.session.settledAt, true);
		check("lastEnded 记录本站", app.storageMap["whytime.lastEnded"].domain, "bilibili.com");

		const h1 = await app.hello(BILI_WWW, 1);
		check("结束后访问 → block（不自由）", h1.action, "block");
		const bc = await app.call({ type: "block-context", ctxId: ctxId }, { tab: { id: 1 } });
		check("block-context → view ended", bc.view, "ended");

		const h2 = await app.hello(BILI_SPACE, 2);
		check("结束后子域 → block", h2.action, "block");
	}

	// ---- Scenario E：Ended 后重新开始 → 全新 Session ----
	console.log("\nScenario E: 重新开始 → 新承诺 → 新 Session");
	{
		const app = boot({});
		await app.listeners.installed({ reason: "install" });
		await app.hello(BILI_WWW, 1);
		const ctxId = app.ctxIdFrom(app.lastBlockUrl());
		const s1 = await app.call({
			type: "start-session", ctxId: ctxId, reason: "第一次", purpose: "娱乐", plannedMinutes: 5
		}, { tab: { id: 1 } });
		const e0 = await app.call({ type: "end-session", ctxId: ctxId }, { tab: { id: 1 } });
		check("未到期主动结束 endKind = user", e0.session && e0.session.endKind, "user");
		backdateLastEnd(app.storageMap, 11); // 冷却期外
		const s2 = await app.call({
			type: "start-session", ctxId: ctxId, reason: "重新承诺", purpose: "学习", plannedMinutes: 20
		}, { tab: { id: 1 } });
		check("重新开始 → 新 Session（不复活）",
				s2.type === "session-started" && s2.session.id !== s1.session.id, true);
		check("新 Session 计划 20 分钟", s2.session && s2.session.plannedSeconds, 1200);
	}

	// ---- Scenario U：每日累计（§7/§9）----
	console.log("\nScenario U: Daily Usage —— 累计/防重/Ended/跨午夜拆分");
	{
		const app = boot({});
		await app.listeners.installed({ reason: "install" });
		await app.hello(BILI_WWW, 1);
		const ctxId = app.ctxIdFrom(app.lastBlockUrl());
		const pad2t = (n) => ((n < 10) ? "0" : "") + n;
		const keyOf = (ms) => {
			const d = new Date(ms);
			return d.getFullYear() + "-" + pad2t(d.getMonth() + 1) + "-" + pad2t(d.getDate());
		};
		const today = keyOf(Date.now());
		const yesterday = keyOf(Date.now() - 86400000);
		const midnight = new Date(new Date().setHours(0, 0, 0, 0)).getTime();

		// Session A：计划 20 分钟，回拨起点 20 分钟并使其刚刚到期
		const sA = await app.call({
			type: "start-session", ctxId: ctxId, reason: "A", purpose: "娱乐", plannedMinutes: 20
		}, { tab: { id: 1 } });
		app.storageMap["whytime.activeSession"].startTime = Date.now() - 20 * 60000;
		app.storageMap["whytime.activeSession"].usageAccountedUntil = Date.now() - 20 * 60000;
		app.storageMap["whytime.activeSession"].plannedEndTime = Date.now() - 1000;
		await app.call({ type: "expire-check", url: BILI_WWW }, { url: BILI_WWW, tab: { id: 1 } });
		const bcA1 = await app.call({ type: "block-context", ctxId: ctxId }, { tab: { id: 1 } });
		check("A 结算后今日累计 ≈ 20 分钟",
				bcA1.todaySeconds >= 1190 && bcA1.todaySeconds <= 1210, true);

		// 刷新页面（重复读取）不得重复累加（§9）
		const bcA2 = await app.call({ type: "block-context", ctxId: ctxId }, { tab: { id: 1 } });
		check("重复读取不重复累计", bcA2.todaySeconds, bcA1.todaySeconds);

		// Session A 结束（expired 状态直接结束）
		await app.call({ type: "end-session", ctxId: ctxId }, { tab: { id: 1 } });
		const realEndA = (app.storageMap["whytime.sessions"] || []).slice(-1)[0].endTime;
		backdateLastEnd(app.storageMap, 11); // 过冷却期
		const bcA3 = await app.call({ type: "block-context", ctxId: ctxId }, { tab: { id: 1 } });
		check("Ended 后今日累计不变", bcA3.todaySeconds, bcA1.todaySeconds);

		// Session B：计划 10 分钟，回拨起点 10 分钟并使其刚刚到期 → 累计 ≈ 30 分钟
		const sB = await app.call({
			type: "start-session", ctxId: ctxId, reason: "B", purpose: "学习", plannedMinutes: 10
		}, { tab: { id: 1 } });
		check("新 Session 继续次数归零（不继承）", sB.session.extensionCount, 0);
		app.storageMap["whytime.activeSession"].startTime = Date.now() - 10 * 60000;
		app.storageMap["whytime.activeSession"].usageAccountedUntil = Date.now() - 10 * 60000;
		app.storageMap["whytime.activeSession"].plannedEndTime = Date.now() - 1000;
		await app.call({ type: "expire-check", url: BILI_WWW }, { url: BILI_WWW, tab: { id: 1 } });
		const bcB = await app.call({ type: "block-context", ctxId: ctxId }, { tab: { id: 1 } });
		check("A+B 后今日累计 ≈ 30 分钟",
				bcB.todaySeconds >= 1790 && bcB.todaySeconds <= 1810, true);
		await app.call({ type: "end-session", ctxId: ctxId }, { tab: { id: 1 } });
		const realEndB = (app.storageMap["whytime.sessions"] || []).slice(-1)[0].endTime;
		backdateLastEnd(app.storageMap, 11); // 过冷却期

		// Session C：跨午夜拆分 —— 昨日 23:55 开始，今日结算
		//（账面：昨日 5 分钟 + 今日剩余；拆分总量 = 墙钟总时长）
		await app.hello(BILI_WWW, 1);
		const ctxC = app.ctxIdFrom(app.lastBlockUrl());
		await app.call({
			type: "start-session", ctxId: ctxC, reason: "C", purpose: "其他", plannedMinutes: 30
		}, { tab: { id: 1 } });
		const startY = midnight - 5 * 60000; // 昨日 23:55
		const todayBeforeC = (app.storageMap["whytime.dailyUsage"] || {})[today] || 0;
		app.storageMap["whytime.activeSession"].startTime = startY;
		app.storageMap["whytime.activeSession"].usageAccountedUntil = startY;
		app.storageMap["whytime.activeSession"].plannedEndTime = Date.now() - 1000;
		const totalSecs = Math.round((Date.now() - startY) / 1000);
		await app.call({ type: "expire-check", url: BILI_WWW }, { url: BILI_WWW, tab: { id: 1 } });

		const usage = app.storageMap["whytime.dailyUsage"];
		check("昨日分桶 ≈ 5 分钟（跨午夜拆分）",
				(usage[yesterday] || 0) >= 295 && (usage[yesterday] || 0) <= 305, true);
		// C 的两日合计 = 昨日 300 秒 + 今日增量（今日此前已有 A+B 的账，须剔除）
		const cTotal = (usage[yesterday] || 0)
				+ ((usage[today] || 0) - todayBeforeC);
		check("C 的两日合计 = 墙钟总时长（±2s 舍入）",
				Math.abs(cTotal - totalSecs) <= 2, true);

		// C 归档后做一致性断言（History 与 ledger 才覆盖同一批 Session）
		await app.call({ type: "end-session", ctxId: ctxC }, { tab: { id: 1 } });
		// 先恢复 A/B 被回拨的真实结束时刻（回拨只是过冷却期的测试手段）
		const arch = app.storageMap["whytime.sessions"];
		arch[arch.length - 3].endTime = realEndA;
		arch[arch.length - 2].endTime = realEndB;
		// 一致性：History 推导的当日实际 = ledger（决策 #1）
		const hAll = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		const derived = app.vmctx.buildDailyReport(hAll.sessions, today);
		check("History 推导今日实际 = dailyUsage ledger",
				derived.actualSecs, usage[today] || 0);
	}

	// ---- Scenario H：History（§17 数据测试）----
	console.log("\nScenario H: History —— 唯一性 / sweep 归档 / 取回 / 上限 / 重启持久");
	{
		const app = boot({
			"whytime.settings": { sites: "bilibili.com", durations: [5, 10, 20, 30, 45, 60], maxExtensions: 2 }
		});
		await app.listeners.installed({ reason: "install" });
		await app.hello(BILI_WWW, 1);
		const ctxId = app.ctxIdFrom(app.lastBlockUrl());
		const startS = (mins, reason) => app.call({
			type: "start-session", ctxId: ctxId, reason: reason, purpose: "学习", plannedMinutes: mins
		}, { tab: { id: 1 } });

		let h = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		check("初始历史为空", h.sessions.length, 0);
		check("下发上限值", h.cap, 1000);

		// Session 1：active → 主动结束
		await startS(5, "第一次");
		await app.call({ type: "end-session", ctxId: ctxId }, { tab: { id: 1 } });
		h = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		check("主动结束 → 1 条", h.sessions.length, 1);
		check("status = ended", h.sessions[0].status, "ended");
		check("endKind = user", h.sessions[0].endKind, "user");
		backdateLastEnd(app.storageMap, 11);

		// 重复 end / 刷新 / 重复 hello 都不产生第二条
		await app.call({ type: "end-session", ctxId: ctxId }, { tab: { id: 1 } });
		await app.call({ type: "block-context", ctxId: ctxId }, { tab: { id: 1 } });
		await app.hello(BILI_WWW, 2);
		await app.call({ type: "end-session", ctxId: ctxId }, { tab: { id: 1 } });
		h = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		check("重复 end / 刷新 / hello 不重复归档", h.sessions.length, 1);

		// Session 2：到期 → 宽限期内保留 → 宽限后 sweep 归档
		await startS(5, "第二次");
		app.storageMap["whytime.activeSession"].plannedEndTime = Date.now() - 1000;
		await app.call({ type: "expire-check", url: BILI_WWW }, { url: BILI_WWW, tab: { id: 1 } });
		h = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		check("宽限期内不归档（承诺窗口保留）", h.sessions.length, 1);
		app.storageMap["whytime.activeSession"].settledAt = Date.now() - 31 * 60000;
		await app.call({ type: "block-context", ctxId: ctxId }, { tab: { id: 1 } });
		h = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		check("宽限后 sweep 归档 → 2 条", h.sessions.length, 2);
		check("sweep 归档 endKind = expiry", h.sessions[1].endKind, "expiry");
		check("activeSession 已清空", app.storageMap["whytime.activeSession"], undefined);

		// 取回：对已归档 Session 明确继续 → 迁回运行时，History 移除该条
		const x1 = await app.call({
			type: "extend-session", ctxId: ctxId, addMinutes: 10, reason: "回来继续"
		}, { tab: { id: 1 } });
		check("sweep 后继续 → 取回成功", x1.type, "session-extended");
		h = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		check("取回后 History 回到 1 条", h.sessions.length, 1);
		check("取回后运行中且预算 +10 分钟",
				app.storageMap["whytime.activeSession"].status === "active"
				&& app.storageMap["whytime.activeSession"].plannedSeconds === 300 + 600, true);

		// 再到期 → 结束 → 重新归档（id 唯一）
		app.storageMap["whytime.activeSession"].plannedEndTime = Date.now() - 1000;
		await app.call({ type: "expire-check", url: BILI_WWW }, { url: BILI_WWW, tab: { id: 1 } });
		await app.call({ type: "end-session", ctxId: ctxId }, { tab: { id: 1 } });
		h = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		check("重新归档 → 2 条且 id 唯一",
				h.sessions.length === 2 && new Set(h.sessions.map((s) => s.id)).size === 2, true);
		check("取回续时后的归档 extensionCount = 1", h.sessions[1].extensionCount, 1);
		backdateLastEnd(app.storageMap, 11);

		// 重启持久（同一 storageMap 新 boot 模拟浏览器重启）
		const app2 = boot(app.storageMap);
		await app2.listeners.installed({ reason: "browser-start" });
		const h2 = await app2.call({ type: "history-get" }, { tab: { id: 1 } });
		check("重启后历史仍在", h2.sessions.length, 2);

		// 上限 1000（超出删最旧）
		const big = [];
		for (let i = 0; i < 1002; i++) {
			big.push({ id: "d" + i, site: "x.com", startTime: 1, endTime: 2,
				plannedSeconds: 60, actualSeconds: 30, purpose: "其他", reason: "r",
				extensionCount: 0, endKind: "expiry", status: "ended" });
		}
		app.storageMap["whytime.sessions"] = big;
		await startS(5, "触发上限");
		await app.call({ type: "end-session", ctxId: ctxId }, { tab: { id: 1 } });
		h = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		check("上限裁剪为 1000", h.sessions.length, 1000);
		check("删的是最旧记录", h.sessions[0].id === "d3", true);
		backdateLastEnd(app.storageMap, 11);

		// 清空：History 与 dailyUsage 清除，activeSession / settings / lastEnded 不动
		await startS(5, "清空测试");
		const beforeClear = app.storageMap["whytime.lastEnded"];
		const cleared = await app.call({ type: "history-clear" }, { tab: { id: 1 } });
		check("history-clear → ok", cleared.ok, true);
		check("History 已清", (app.storageMap["whytime.sessions"] || []).length, 0);
		check("dailyUsage 已清", app.storageMap["whytime.dailyUsage"], undefined);
		check("activeSession 不受影响", app.storageMap["whytime.activeSession"].status, "active");
		check("lastEnded 不受影响", app.storageMap["whytime.lastEnded"], beforeClear);
	}

	// ---- Scenario T：跨子域 Session 连续性 + 计时条 × 提前结束 ----
	console.log("\nScenario T: 同一 configured site 共用一个 Session + × = 主动结束");
	{
		const app = boot({});
		await app.listeners.installed({ reason: "install" });

		// 从 message.bilibili.com 进入并承诺
		await app.hello("https://message.bilibili.com/", 1);
		const ctxId = app.ctxIdFrom(app.lastBlockUrl());
		const s1 = await app.call({
			type: "start-session", ctxId: ctxId, reason: "搜索b端产品经理",
			purpose: "学习", plannedMinutes: 5
		}, { tab: { id: 1 } });
		check("Session 身份 = configured site（bilibili.com）", s1.session.domain, "bilibili.com");
		const plannedEnd1 = s1.session.plannedEndTime;

		// 子域 / 页面切换：同一 Session、同一 plannedEndTime、reason 连续
		for (const [name, url] of [
			["www 视频页", "https://www.bilibili.com/video/BVxxxx"],
			["space", "https://space.bilibili.com/71307664"],
			["search", "https://search.bilibili.com/all?keyword=x"],
			["www list 页", "https://www.bilibili.com/list/xxx"],
			["message 回访", "https://message.bilibili.com/"]
		]) {
			const hh = await app.hello(url, 2);
			check(name + " → allow 同一 Session",
					hh.action === "allow" && hh.session.id === s1.session.id, true);
			check(name + " plannedEndTime 不变", hh.session.plannedEndTime === plannedEnd1, true);
			check(name + " reason 连续", hh.session.reason, "搜索b端产品经理");
		}

		// 伪域名不受影响
		const outsider = await app.hello("https://notbilibili.com/", 3);
		check("notbilibili → allow 且无 session", outsider.action === "allow" && !outsider.session, true);

		// 计时条 ×：主动结束（content 侧只发消息，归档全在后台）
		const e = await app.call({
			type: "end-active", url: "https://www.bilibili.com/video/BVxxxx"
		}, { url: "https://www.bilibili.com/video/BVxxxx", tab: { id: 2 } });
		check("end-active → block（去 blocked.html）", e.action, "block");
		let h = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		check("History +1", h.sessions.length, 1);
		check("endKind = user", h.sessions[0].endKind, "user");
		check("status = ended", h.sessions[0].status, "ended");
		check("实际 < 计划（提前结束）",
				h.sessions[0].actualSeconds < h.sessions[0].plannedSeconds, true);
		check("activeSession 已清", app.storageMap["whytime.activeSession"], undefined);

		// Ended 视图带鼓励语
		const bc = await app.call({
			type: "block-context", ctxId: app.ctxIdFrom(app.lastBlockUrl())
		}, { tab: { id: 2 } });
		check("view = ended", bc.view, "ended");
		check("鼓励语文案存在", typeof bc.encourage === "string" && bc.encourage.length > 0, true);

		// 连续快速点击 ×（幂等）
		const e2 = await app.call({
			type: "end-active", url: "https://www.bilibili.com/video/BVxxxx"
		}, { tab: { id: 2 } });
		check("重复 × 幂等（不再导航）", e2.action, "allow");
		h = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		check("仍只有 1 条 History", h.sessions.length, 1);
		backdateLastEnd(app.storageMap, 11); // × 结束后的冷却期外

		// 竞态：已到期（expired）再点 × → 只能有一条，先到期者赢
		await app.hello(BILI_WWW, 1);
		const ctx2 = app.ctxIdFrom(app.lastBlockUrl());
		await app.call({
			type: "start-session", ctxId: ctx2, reason: "竞态", purpose: "其他", plannedMinutes: 5
		}, { tab: { id: 1 } });
		app.storageMap["whytime.activeSession"].plannedEndTime = Date.now() - 1000;
		await app.call({ type: "expire-check", url: BILI_WWW }, { url: BILI_WWW, tab: { id: 1 } });
		const e3 = await app.call({ type: "end-active", url: BILI_WWW }, { url: BILI_WWW, tab: { id: 1 } });
		check("expired 后点 × → 仍返回 block", e3.action, "block");
		const h3 = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		check("到期竞态共 2 条（无 expiry/user 分裂）", h3.sessions.length, 2);
		check("竞态记录 endKind = expiry", h3.sessions[1].endKind, "expiry");
	}

	// ---- Scenario K：关键词条目（不含点号）----
	console.log("\nScenario K: 关键词模式 —— 主机名含词即约束，Session 身份 = 关键词");
	{
		const app = boot({
			"whytime.settings": { sites: "bilibili", durations: [5, 10, 20, 30, 45, 60], maxExtensions: 2 }
		});
		check("无 Session 时 notbilibili.com 主机含词 → block（关键词语义）",
				(await app.hello("https://notbilibili.com/", 3)).action, "block");
		check("URL 路径含词不算、主机不含词不命中",
				(await app.hello("https://www.google.com/search?q=bilibili")).action, "allow");

		await app.hello("https://message.bilibili.com/", 1);
		const ctxId = app.ctxIdFrom(app.lastBlockUrl());
		const s1 = await app.call({
			type: "start-session", ctxId: ctxId, reason: "关键词模式", purpose: "学习", plannedMinutes: 5
		}, { tab: { id: 1 } });
		check("Session 身份 = 关键词条目本身", s1.session.domain, "bilibili");

		for (const url of ["https://www.bilibili.com/video/x", "https://bilibili.tv/a"]) {
			const hh = await app.hello(url, 2);
			check(url + " → allow 同一 Session",
					hh.action === "allow" && hh.session.id === s1.session.id, true);
		}
		check("notbilibili.com 主机含词 → 属于同一站点 → 放行同 Session（关键词语义）",
				((hh) => hh.action === "allow" && hh.session.id === s1.session.id)(
						await app.hello("https://notbilibili.com/", 3)), true);
		check("URL 路径含词不算、主机不含词不命中",
				(await app.hello("https://www.google.com/search?q=bilibili")).action, "allow");

		// 大小写加固（2026-10-03 用户报告）：storage 残留大写条目也要命中，
		// 且 Session 身份归一为小写
		const appU = boot({
			"whytime.settings": { sites: "YouTube", durations: [5, 10, 20, 30, 45, 60], maxExtensions: 2 }
		});
		const hu = await appU.hello("https://www.youtube.com/", 1);
		check("storage 大写 YouTube → youtube.com block", hu.action, "block");
		check("URL host 大写同样命中",
				(await appU.hello("https://www.YouTube.com/", 2)).action, "block");
		const su = await appU.call({
			type: "start-session", ctxId: appU.ctxIdFrom(appU.lastBlockUrl()),
			reason: "大小写", purpose: "学习", plannedMinutes: 5
		}, { tab: { id: 1 } });
		check("Session 身份归一为小写", su.session.domain, "youtube");
	}

	// ---- Scenario K2：混合名单（域名条目 + 关键词条目）----
	console.log("\nScenario K2: 混合名单 —— bilibili.com（域名）+ weibo（关键词）");
	{
		const app = boot({
			"whytime.settings": { sites: "bilibili.com\nweibo", durations: [5, 10, 20, 30, 45, 60], maxExtensions: 2 }
		});
		check("notbilibili.com → allow（bilibili.com 域名条目边界安全）",
				(await app.hello("https://notbilibili.com/", 4)).action, "allow");
		check("weibo.com → block（关键词条目）",
				(await app.hello("https://weibo.com/", 1)).action, "block");
		const ctxW = app.ctxIdFrom(app.lastBlockUrl());
		const sw = await app.call({
			type: "start-session", ctxId: ctxW, reason: "微博", purpose: "社交", plannedMinutes: 5
		}, { tab: { id: 1 } });
		check("weibo Session 身份 = weibo", sw.session.domain, "weibo");
		const hh = await app.hello("https://s.weibo.cn/weibo?q=1", 2);
		check("s.weibo.cn → allow 同一 Session（不同后缀同词）",
				hh.action === "allow" && hh.session.id === sw.session.id, true);
		check("bilibili.com → block（域名条目）",
				(await app.hello(BILI_WWW, 3)).action, "block");
	}

	// ---- Scenario I：目的对齐检查（每 10 分钟）----
	console.log("\nScenario I: Intention Check —— 检查下发/一致/偏离继续/偏离结束");
	{
		const app = boot({
			"whytime.settings": { sites: "bilibili.com", durations: [5, 10, 20, 30, 45, 60], maxExtensions: 2 }
		});
		await app.listeners.installed({ reason: "install" });
		await app.hello(BILI_WWW, 1);
		const ctxId = app.ctxIdFrom(app.lastBlockUrl());
		await app.call({
			type: "start-session", ctxId: ctxId, reason: "对齐测试", purpose: "学习", plannedMinutes: 30
		}, { tab: { id: 1 } });

		// 到点：SW 只向活动标签页发 intention-check
		const sentBefore = app.listeners.sent.length;
		await app.listeners.alarm({ name: "whytime-check" });
		const checkMsg = app.listeners.sent.slice(sentBefore)
				.find((m) => m.msg.type === "intention-check");
		check("check alarm → 向活动 tab 下发 intention-check", !!checkMsg, true);

		// 答"一致"→ 关闭弹窗，checkIns +1
		let r = await app.call({ type: "intention-answer", url: BILI_WWW, consistent: true },
				{ url: BILI_WWW, tab: { id: 1 } });
		check("一致 → dismiss", r.action, "dismiss");
		check("checkIns = 1",
				app.storageMap["whytime.activeSession"].checkIns.length, 1);

		// 偏离但写理由继续 → 记录偏离原因
		r = await app.call({ type: "intention-answer", url: BILI_WWW, consistent: false,
				action: "continue", reason: "刷了推荐视频" }, { url: BILI_WWW, tab: { id: 1 } });
		check("偏离+理由 → dismiss（继续使用）", r.action, "dismiss");
		check("checkIns = 2 且偏离原因已记录",
				app.storageMap["whytime.activeSession"].checkIns.length === 2
				&& app.storageMap["whytime.activeSession"].checkIns[1].reason === "刷了推荐视频", true);
		check("偏离继续不打断 Session（仍 active）",
				app.storageMap["whytime.activeSession"].status, "active");

		// 空理由的偏离继续被拒
		r = await app.call({ type: "intention-answer", url: BILI_WWW, consistent: false,
				action: "continue", reason: "  " }, { url: BILI_WWW, tab: { id: 1 } });
		check("空偏离理由被 SW 拒绝", r.type, "error");

		// 偏离且选择结束 → 统一归档 + 带 Ended 视图
		const sentB2 = app.listeners.sent.length;
		r = await app.call({ type: "intention-answer", url: BILI_WWW, consistent: false,
				action: "end" }, { url: BILI_WWW, tab: { id: 1 } });
		check("偏离+结束 → block（去 blocked.html）", r.action, "block");
		const h = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		check("History 1 条且 checkIns = 3",
				h.sessions.length === 1 && h.sessions[0].checkIns.length === 3, true);
		check("endKind = user", h.sessions[0].endKind, "user");
		const csvI = app.vmctx.historyToCSV(h.sessions);
		check("CSV 新列齐全", ["checkIns", "inconsistent", "deviations", "reviewDeviated", "reviewReason"]
				.every((c) => csvI.replace(/^\uFEFF/, "").split("\r\n")[0].indexOf(c) !== -1), true);
		check("CSV 行含偏离原因", csvI.indexOf('"刷了推荐视频"') !== -1, true);
		check("行统计 checkIns=3 / inconsistent=2",
				/"3","2"/.test(csvI), true);

		// Ended 视图带"省下的时间"（提前收场的正反馈）
		const ctxEnd = app.ctxIdFrom(app.lastBlockUrl());
		const bcEnd = await app.call({ type: "block-context", ctxId: ctxEnd }, { tab: { id: 1 } });
		check("Ended 视图带省下的分钟数（30 分钟几乎未用）", bcEnd.savedMin, 30);
	}

	// ---- Scenario S2：自适应检查间隔（对抗"预算授予感"）----
	console.log("\nScenario S2: 自适应检查间隔 —— 计划/4，收敛 2-10 分钟");
	{
		const lastCheck = async (mins) => {
			const app = boot({
				"whytime.settings": { sites: "bilibili.com", durations: [5, 10, 20, 30, 45, 60], maxExtensions: 2 }
			});
			await app.listeners.installed({ reason: "install" });
			await app.hello(BILI_WWW, 1);
			const ctxId = app.ctxIdFrom(app.lastBlockUrl());
			await app.call({
				type: "start-session", ctxId: ctxId, reason: "间隔", purpose: "学习", plannedMinutes: mins
			}, { tab: { id: 1 } });
			const checks = app.listeners.alarms.filter((a) => a.name === "whytime-check");
			return checks[checks.length - 1];
		};
		const c15 = await lastCheck(15);
		check("15 分钟 → 每 4 分钟检查（1/3 处递台阶）", c15.info.periodInMinutes, 4);
		const c5 = await lastCheck(5);
		check("5 分钟 → 每 2 分钟检查（下限）", c5.info.periodInMinutes, 2);
		const c60 = await lastCheck(60);
		check("60 分钟 → 每 10 分钟检查（上限，维持原节奏）", c60.info.periodInMinutes, 10);
	}

	// ---- Scenario V：到期偏离回顾 ----
	console.log("\nScenario V: Deviation Review —— 到期回顾随归档进 History/CSV");
	{
		const app = boot({
			"whytime.settings": { sites: "bilibili.com", durations: [5, 10, 20, 30, 45, 60], maxExtensions: 2 }
		});
		await app.listeners.installed({ reason: "install" });
		await app.hello(BILI_WWW, 1);
		const ctxId = app.ctxIdFrom(app.lastBlockUrl());
		await app.call({
			type: "start-session", ctxId: ctxId, reason: "回顾测试", purpose: "学习", plannedMinutes: 1
		}, { tab: { id: 1 } });
		app.storageMap["whytime.activeSession"].plannedEndTime = Date.now() - 1000;
		await app.call({ type: "expire-check", url: BILI_WWW }, { url: BILI_WWW, tab: { id: 1 } });

		// 有偏离必须写原因
		let r = await app.call({ type: "deviation-review", ctxId: ctxId, deviated: true, reason: " " },
				{ tab: { id: 1 } });
		check("有偏离但空原因被拒", r.type, "error");

		r = await app.call({ type: "deviation-review", ctxId: ctxId, deviated: true,
				reason: "看了首页推荐，跑题了" }, { tab: { id: 1 } });
		check("偏离回顾提交成功", r.ok, true);
		check("回顾已落到 Session",
				app.storageMap["whytime.activeSession"].deviationReview.deviated === true
				&& app.storageMap["whytime.activeSession"].deviationReview.reason === "看了首页推荐，跑题了", true);

		// 归档后进 History/CSV
		await app.call({ type: "end-session", ctxId: ctxId }, { tab: { id: 1 } });
		const h = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		check("归档记录带回顾", h.sessions[0].deviationReview
				&& h.sessions[0].deviationReview.deviated === true, true);
		const csv = app.vmctx.historyToCSV(h.sessions);
		check("CSV reviewDeviated=是 且含原因",
				csv.indexOf('"是"') !== -1 && csv.indexOf('"看了首页推荐，跑题了"') !== -1, true);

		backdateLastEnd(app.storageMap, 11);
		// 对照：没有偏离的回顾
		await app.hello(BILI_WWW, 1);
		const ctx2 = app.ctxIdFrom(app.lastBlockUrl());
		await app.call({
			type: "start-session", ctxId: ctx2, reason: "对照", purpose: "学习", plannedMinutes: 1
		}, { tab: { id: 1 } });
		app.storageMap["whytime.activeSession"].plannedEndTime = Date.now() - 1000;
		await app.call({ type: "expire-check", url: BILI_WWW }, { url: BILI_WWW, tab: { id: 1 } });
		await app.call({ type: "deviation-review", ctxId: ctx2, deviated: false }, { tab: { id: 1 } });
		await app.call({ type: "end-session", ctxId: ctx2 }, { tab: { id: 1 } });
		const h2 = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		const csv2 = app.vmctx.historyToCSV(h2.sessions);
		check("无偏离记录 CSV = 否", csv2.indexOf('"否"') !== -1, true);
	}

	// ---- Scenario Co：回合间冷静期（对抗连续使用的习惯化）+ 宵禁强制 ----
	console.log("\nScenario Co: 冷却升级/上限 + 宵禁强制结束");
	{
		const app = boot({
			"whytime.settings": { sites: "bilibili.com", durations: [5, 10, 20, 30, 45, 60], maxExtensions: 2 }
		});
		await app.listeners.installed({ reason: "install" });
		await app.hello(BILI_WWW, 1);
		const ctxId = app.ctxIdFrom(app.lastBlockUrl());
		const startS = (r) => app.call({
			type: "start-session", ctxId: ctxId, reason: r, purpose: "娱乐", plannedMinutes: 1
		}, { tab: { id: 1 } });

		await startS("第一次");
		await app.call({ type: "end-session", ctxId: ctxId }, { tab: { id: 1 } });

		// 结束后立刻看 Gate 信息：今天第 1 次，冷却中
		let bc = await app.call({ type: "block-context", ctxId: ctxId }, { tab: { id: 1 } });
		check("Ended 视图带 gateInfo（今天第 1 次）", bc.gateInfo && bc.gateInfo.todayCount, 1);
		check("冷却中（约 2 分钟）",
				Math.abs((bc.gateInfo.cooldownUntil - Date.now()) - 120000) < 5000, true);

		// 冷静期内 start 被 SW 强制拒绝（UI 只是投影）
		const rej = await startS("马上再来");
		check("冷静期内 start 被拒且提示冷静", rej.type === "error"
				&& rej.message.indexOf("冷静") !== -1, true);

		// 回拨过冷却期 → 可以开始第二次
		backdateLastEnd(app.storageMap, 11);
		const s2 = await startS("第二次");
		check("冷却期外可开始", s2.type, "session-started");
		await app.call({ type: "end-session", ctxId: ctxId }, { tab: { id: 1 } });

		// 第二次结束后冷却升级为 4 分钟
		bc = await app.call({ type: "block-context", ctxId: ctxId }, { tab: { id: 1 } });
		check("冷却升级为 4 分钟（今天第 2 次）",
				bc.gateInfo.todayCount === 2
				&& Math.abs((bc.gateInfo.cooldownUntil - Date.now()) - 240000) < 5000, true);

		// 预置 4 条今日归档（+前面 2 条 = 6 次）→ 冷却触及 10 分钟上限
		const seeded = app.storageMap["whytime.sessions"] || [];
		for (let i = 0; i < 4; i++) {
			seeded.push({ id: "seed" + i, site: "bilibili.com", domain: "bilibili.com", startTime: Date.now() - 3600000,
				endTime: Date.now() - 1800000, plannedSeconds: 600, actualSeconds: 600,
				purpose: "娱乐", reason: "种子", extensionCount: 0, endKind: "expiry", status: "ended" });
		}
		app.storageMap["whytime.sessions"] = seeded;
		bc = await app.call({ type: "block-context", ctxId: ctxId }, { tab: { id: 1 } });
		check("今天第 6 次", bc.gateInfo.todayCount, 6);
		check("冷却触及上限 10 分钟",
				Math.abs((bc.gateInfo.cooldownUntil - Date.now()) - 600000) < 5000, true);

		// 宵禁强制结束（动态窗口：当前时刻前后各 1 分钟，保证命中）
		backdateLastEnd(app.storageMap, 11); // 过冷却期
		const hm = (d) => d.getHours() * 60 + d.getMinutes();
		const nowD = new Date();
		const p2t = (n) => ((n < 10) ? "0" : "") + n;
		const fmtH = (mins) => { const m = ((mins % 1440) + 1440) % 1440; return Math.floor(m / 60) + ":" + p2t(m % 60); };
		const stCf = await startS("宵禁前"); // 先开始（此时窗口未激活）
		if (stCf.type !== "session-started") {
			console.log("DEBUG curfew start rejected:", JSON.stringify(stCf), "settings:", JSON.stringify(app.storageMap["whytime.settings"]));
		}
		app.storageMap["whytime.settings"].curfewStart = fmtH(hm(nowD) - 1);
		app.storageMap["whytime.settings"].curfewEnd = fmtH(hm(nowD) + 1);
		await app.listeners.alarm({ name: "whytime-curfew" }); // 宵禁到点：强制结束
		check("宵禁到点强制结束", app.storageMap["whytime.activeSession"], undefined);
		const hCf = await app.call({ type: "history-get" }, { tab: { id: 1 } });
		check("宵禁结束 endKind = curfew", hCf.sessions[hCf.sessions.length - 1].endKind, "curfew");

		// 恢复正常宵禁设置
		app.storageMap["whytime.settings"].curfewStart = "22:00";
		app.storageMap["whytime.settings"].curfewEnd = "06:00";
	}

	// ---- Scenario D：默认值语义 ----
	console.log("\nScenario D: 用户名单语义不被默认值覆盖");
	{
		const a1 = boot({ "whytime.settings": { sites: "", durations: [5, 10, 20, 30, 45, 60], maxExtensions: 2 } });
		check("空名单 → allow", (await a1.hello(BILI_WWW)).action, "allow");
		check("storage 未被改写", a1.storageMap["whytime.settings"].sites, "");

		const a2 = boot({ "whytime.settings": { sites: "youtube.com", durations: [5, 10, 20, 30, 45, 60], maxExtensions: 2 } });
		check("名单只有 youtube → B站 allow（不自动加回）", (await a2.hello(BILI_WWW)).action, "allow");
		check("youtube → block", (await a2.hello("https://www.youtube.com/")).action, "block");

		const a3 = boot({ "whytime.settings": { sites: "bilibili.com", durations: [5, 10, 20, 30, 45, 60], maxExtensions: 2 } });
		check("bilibili.com → www block", (await a3.hello(BILI_WWW)).action, "block");
		check("bilibili.com → space block", (await a3.hello(BILI_SPACE)).action, "block");
		check("bilibili.com → message block", (await a3.hello(BILI_MSG)).action, "block");
	}
}

main().then(() => {
	console.log("-".repeat(66));
	if (failures === 0) {
		console.log("ALL PASS");
	} else {
		console.log("FAILURES: " + failures);
		process.exit(1);
	}
}).catch((err) => {
	console.error("HARNESS ERROR:", err);
	process.exit(1);
});
