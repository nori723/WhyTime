/* WhyTime DOM 垫片测试：在 Node 里执行真实的 blocked.js / options.js，
 * 捕获渲染路径中的运行时错误与监听器挂载情况。
 * 动机：用户报告"插件无法点击按钮"——按钮在、处理器死 = 某条渲染路径抛错。
 * 运行：node tests/test-dom.js
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

/* ---------- DOM 垫片 ---------- */

function makeEl(tag, id) {
	const el = {
		tag: tag || "div",
		id: id || "",
		children: [],
		style: {},
		dataset: {},
		value: "",
		textContent: "",
		_hidden: false,
		_listeners: {},
		_innerHTML: "",
		href: "",
		disabled: false,
		parentNode: null,
		isConnected: true,
		addEventListener(type, fn) {
			(el._listeners[type] = el._listeners[type] || []).push(fn);
		},
		removeEventListener() {},
		dispatch(type, ev) {
			ev = ev || { target: el, preventDefault() {}, clientX: 0, clientY: 0, pointerId: 1 };
			for (const fn of (el._listeners[type] || []).slice()) fn(ev);
		},
		append(child) { el.children.push(child); return child; },
		appendChild(child) { el.children.push(child); return child; },
		removeChild(child) {
			const i = el.children.indexOf(child);
			if (i >= 0) el.children.splice(i, 1);
			return child;
		},
		focus() {},
		setPointerCapture() {},
		attachShadow() { return makeShadow(); }
	};
	el.classList = {
		_set: new Set(),
		add(c) { this._set.add(c); },
		remove(c) { this._set.delete(c); },
		toggle(c, f) {
			const has = this._set.has(c);
			if (f === undefined) { has ? this._set.delete(c) : this._set.add(c); }
			else { f ? this._set.add(c) : this._set.delete(c); }
		},
		contains(c) { return this._set.has(c); }
	};
	Object.defineProperty(el, "hidden", {
		get() { return this._hidden; },
		set(v) { this._hidden = !!v; }
	});
	Object.defineProperty(el, "offsetWidth", { get() { return 300; } });
	Object.defineProperty(el, "offsetHeight", { get() { return 40; } });
	return el;
}

function makeShadow() {
	const els = {};
	return {
		appendChild(el) { els[el.id || "anon"] = el; },
		getElementById(id) { return els[id] || null; }
	};
}

function makeDocument() {
	const registry = {};
	const doc = {
		readyState: "complete",
		body: makeEl("body"),
		documentElement: makeEl("html"),
		fullscreenElement: null,
		addEventListener() {},
		removeEventListener() {},
		createElement(tag) { return makeEl(tag); },
		getElementById(id) {
			if (!registry[id]) registry[id] = makeEl("div", id);
			return registry[id];
		},
		querySelectorAll() { return []; },
		querySelector() { return null; }
	};
	return doc;
}

function makeChromeExt(storageMap) {
	const sent = [];
	const out = {
		sent: sent,
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
		runtime: {
			sendMessage: (msg) => new Promise((resolve) => {
				sent.push({ msg: msg, resolve: resolve });
			}),
			onMessage: { addListener: () => {} },
			getURL: (p) => "chrome-extension://whytime/" + p
		}
	};
	out.resolveSend = function (res) {
		const pending = sent.shift();
		if (pending) pending.resolve(res);
	};
	return out;
}

function makeWindow() {
	const L = {};
	const w = {
		__fire(type) { for (const fn of (L[type] || []).slice()) fn(); },
		addEventListener(type, fn) { (L[type] = L[type] || []).push(fn); },
		removeEventListener() {},
		innerWidth: 1200,
		innerHeight: 800,
		location: { href: "https://www.bilibili.com/", search: "" },
		setTimeout: (fn) => { fn(); return 1; }, // 立即执行一次（倒计时直接到结束态）
		clearTimeout() {},
		setInterval(fn) { fn(); return 1; }, // 立即执行一次 tick，视为已到期
		clearInterval() {},
		stop() {}
	};
	return w;
}

function bootBlocked(response) {
	const doc = makeDocument();
	const chrome = makeChromeExt({
		"whytime.settings": { sites: "bilibili.com", altName: "阅读|运动", altUrl: "https://weread.qq.com/web|" }
	});
	const errors = [];
	process.on("unhandledRejection", function (e) {
		const msg = String(e && e.message || e);
		const line = String(e && e.stack || "").split("\n")[1] || "";
		errors.push(msg + " @ " + line.trim());
		console.log("  REJECTION:", msg, "@", line.trim());
	});
	const ctx = {
		chrome: chrome, document: doc, console: console,
		location: { href: "chrome-extension://whytime/blocked.html?ctx=test", search: "?ctx=test" },
		navigator: { clipboard: { writeText: async () => {} } },
		window: { location: { href: "chrome-extension://whytime/blocked.html?ctx=test" }, stop() {} },
		// 假定时器：立即执行一次且不留句柄，保证测试进程可退出
		setTimeout: (fn) => { fn(); return 1; },
		clearTimeout: () => {},
		setInterval: (fn) => { fn(); return 1; },
		clearInterval: () => {},
		URL: URL, URLSearchParams: URLSearchParams, MouseEvent: function () {},
		Date: Date, Math: Math, JSON: JSON, Promise: Promise
	};
	ctx.importScripts = () => {};
	vm.createContext(ctx);
	vm.runInContext(read("blocked.js"), ctx, { filename: "blocked.js" });
	return { ctx: ctx, doc: doc, chrome: chrome, errors: errors, resolveSend: chrome.resolveSend };
}

/* ---------- Part 1: blocked.js 渲染路径 ---------- */

const SESSION = {
	id: "s1", domain: "bilibili.com", url: "https://www.bilibili.com/",
	reason: "查教程", purpose: "学习",
	initialPlannedSeconds: 300, plannedSeconds: 300,
	startTime: Date.now() - 60000, plannedEndTime: Date.now() + 240000,
	actualSeconds: 60, extensionCount: 1,
	extensions: [{ reason: "第一段", addMinutes: 5, at: Date.now() }],
	status: "active"
};

async function part1() {
	// Gate 视图
	{
		const b = bootBlocked();
		b.resolveSend({
			view: "gate", durations: [5, 10, 20, 30, 45, 60], todaySeconds: 0,
			gateInfo: { todayCount: 0, todaySiteSecs: 0, todayExtCount: 0, cooldownUntil: 0 },
			returnUrl: "https://www.bilibili.com/"
		});
		await new Promise((r) => setTimeout(r, 50));
		const view = b.doc.getElementById("view");
		check("gate 渲染包含开始按钮", (view.innerHTML || "").indexOf("开始使用") !== -1, true);
		check("gate 开始按钮已接线",
				(b.doc.getElementById("startBtn")._listeners.click || []).length > 0, true);
		check("gate 渲染接下来字段（必填同款输入）", (view.innerHTML || "").indexOf("接下来去") !== -1
				&& (view.innerHTML || "").indexOf("例如：去阅读") !== -1, true);
		check("gate 渲染下一步提示行", (view.innerHTML || "").indexOf("空档才是") !== -1, true);
		check("gate 时长档为两排对齐网格", (view.innerHTML || "").indexOf("chips-grid") !== -1, true);
		check("gate 渲染无未捕获异常", b.errors.length, 0);
	}
	// Gate + 冷却期：开始按钮禁用
	{
		const b = bootBlocked();
		b.resolveSend({
			view: "gate", durations: [5, 10, 20, 30, 45, 60], todaySeconds: 0,
			gateInfo: { todayCount: 2, todaySiteSecs: 3600, todayExtCount: 1,
				cooldownUntil: Date.now() + 240000 },
			returnUrl: "https://www.bilibili.com/"
		});
		await new Promise((r) => setTimeout(r, 50));
		check("冷却期开始按钮禁用", b.doc.getElementById("startBtn").disabled, true);
		check("冷却提示渲染", (b.doc.getElementById("view").innerHTML || "")
				.indexOf("冷静期") !== -1, true);
		check("冷却期渲染无未捕获异常", b.errors.length, 0);
	}
	// Expired 视图（承诺表单 + 15 秒冷却 + 替代入口 + 前理由）
	{
		const b = bootBlocked();
		const res = {
			view: "expired", session: JSON.parse(JSON.stringify(SESSION)),
			maxExtensions: 2, altList: [{ name: "阅读", url: "https://weread.qq.com/web" }, { name: "运动", url: "" }],
			todayExtCount: 2, returnUrl: "https://www.bilibili.com/"
		};
		b.resolveSend(res);
		await new Promise((r) => setTimeout(r, 50));
		const view = b.doc.getElementById("view");
		check("expired 渲染继续/结束按钮", (view.innerHTML || "").indexOf("继续使用") !== -1
				&& (view.innerHTML || "").indexOf("结束使用") !== -1, true);
		check("expired 渲染今日延长次数", (view.innerHTML || "").indexOf("今天这是第 2 次延长") !== -1, true);
		// 偏离回顾必答（v0.16.1）：未作答前 继续使用/结束使用 锁定
		const contBtn = b.doc.getElementById("continueBtn");
		check("未作答时继续/结束按钮锁定",
				contBtn.disabled === true && b.doc.getElementById("endBtn").disabled === true, true);
		const showBtn = b.doc.getElementById("showPromiseBtn");
		check("继续使用按钮已接线", (showBtn._listeners.click || []).length > 0, true);
		// 作答回顾（没有偏离）→ 解锁
		b.doc.getElementById("reviewNoBtn").dispatch("click");
		await new Promise((r) => setTimeout(r, 30));
		b.resolveSend({ ok: true });
		await new Promise((r) => setTimeout(r, 30));
		check("作答后按钮解锁", contBtn.disabled === false
				&& b.doc.getElementById("endBtn").disabled === false, true);
		showBtn.dispatch("click");
		const confirmBtn = b.doc.getElementById("confirmBtn");
		check("展开后确认按钮处于冷却禁用", confirmBtn.disabled === true, true);
		check("承诺表单内替代入口可见",
				(view.innerHTML || "").indexOf("现在就离开，去") !== -1, true);
		check("前几次的理由已展示", (view.innerHTML || "").indexOf("前几次的理由") !== -1, true);
		check("expired 渲染无未捕获异常", b.errors.length, 0);
	}
	// Ended 视图（正反馈 + 替代动作）
	{
		const b = bootBlocked();
		b.resolveSend({
			view: "ended", altList: [{ name: "运动", url: "" }],
			gateInfo: { todayCount: 3, todaySiteSecs: 7200, todayExtCount: 2, cooldownUntil: 0 },
			returnUrl: "https://www.bilibili.com/"
		});
		await new Promise((r) => setTimeout(r, 50));
		const view = b.doc.getElementById("view");
		check("ended 渲染正反馈句", (view.innerHTML || "").indexOf("你停下来了。这比继续难。") !== -1, true);
		check("ended 渲染替代动作盒", (view.innerHTML || "").indexOf("换个地方待一会儿") !== -1
				&& (view.innerHTML || "").indexOf("运动") !== -1, true);
		check("ended 重新开始按钮已接线",
				(b.doc.getElementById("restartBtn")._listeners.click || []).length > 0, true);
		check("ended 渲染无未捕获异常", b.errors.length, 0);
	}
	// Break 视图
	{
		const b = bootBlocked();
		const session = JSON.parse(JSON.stringify(SESSION));
		session.breakUntil = Date.now() + 120000;
		b.resolveSend({ view: "break", session: session, returnUrl: "https://www.bilibili.com/" });
		await new Promise((r) => setTimeout(r, 50));
		const view = b.doc.getElementById("view");
		check("break 渲染拉伸清单与倒计时", (view.innerHTML || "").indexOf("股四头肌") !== -1
				&& (view.innerHTML || "").indexOf("breakTimer") !== -1, true);
		check("break 回去按钮初始禁用（模板含 disabled）",
				(view.innerHTML || "").indexOf('id="backBtn" class="btn-primary" disabled') !== -1, true);
		check("break 渲染无未捕获异常", b.errors.length, 0);
	}
}

/* ---------- Part 2: options.js 设置路径 ---------- */

async function part2() {
	const html = read("options.html");
	const storageMap = {
		"whytime.settings": { sites: "bilibili.com", durations: [5, 10, 20, 30, 45, 60], maxExtensions: 2 }
	};
	const doc = makeDocument();
	const chrome = makeChromeExt(storageMap);
	const errors = [];
	process.on("unhandledRejection", function (e) {
		errors.push(String(e && e.message || e));
	});
	const win = makeWindow();
	const ctx = {
		chrome: chrome, document: doc, console: console, window: win,
		location: { href: "chrome-extension://whytime/options.html" },
		setTimeout, clearTimeout, URL, URLSearchParams, Promise, Date: Date
	};
	vm.createContext(ctx);
	vm.runInContext(read("common.js"), ctx, { filename: "common.js" });
	vm.runInContext(read("wt-util.js"), ctx, { filename: "wt-util.js" });
	vm.runInContext(read("options.js"), ctx, { filename: "options.js" });
	win.__fire("DOMContentLoaded");
	await new Promise((r) => setTimeout(r, 50));

	check("options loadSettings 无未捕获异常", errors.length, 0);
	check("options 替代动作名回显默认", doc.getElementById("altName").value, "阅读|运动");
	check("options 替代链接回显默认",
			doc.getElementById("altUrl").value.indexOf("weread.qq.com") !== -1, true);

	doc.getElementById("altName").value = "阅读|散步";
	doc.getElementById("altUrl").value = "https://weread.qq.com/web|";
	doc.getElementById("sites").value = "bilibili.com\nyoutube.com";
	doc.getElementById("save").dispatch("click");
	await new Promise((r) => setTimeout(r, 50));
	check("保存无未捕获异常", errors.length, 0);
	check("替代动作已落库", (storageMap["whytime.settings"].altName || "") === "阅读|散步", true);
	check("两个保存按钮都已接线",
			(doc.getElementById("save")._listeners.click || []).length > 0
			&& (doc.getElementById("save2")._listeners.click || []).length > 0, true);
	check("保存后回显仍正常", doc.getElementById("altName").value, "阅读|散步");
}

part1().then(part2).then(() => {
	console.log("-".repeat(58));
	if (failures === 0) {
		console.log("ALL PASS");
	} else {
		console.log("FAILURES: " + failures);
		process.exit(1);
	}
}).catch((e) => {
	console.error("HARNESS ERROR:", e);
	process.exit(1);
});
