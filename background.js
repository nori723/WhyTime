/* WhyTime background service worker.
 *
 * Message-dispatch and listener patterns derive from LeechBlock NG
 * (MPL-2.0); the page-requests-context pattern of LeechBlock's
 * blocked.js is reused for our blocked.html. The session state machine
 * is new WhyTime code.
 *
 * Architecture (Phase 1.4): blocked.html is THE blocking layer.
 *  - Gate / Expired / Promise / Ended all live on blocked.html.
 *  - The content script is thin: ask for a verdict on page load; if the
 *    verdict is "block", the BACKGROUND navigates the tab to
 *    blocked.html via chrome.tabs.update (needs no extra permission).
 *  - Return URLs never travel through query parameters. The background
 *    issues an opaque ctx token bound to the real page URL; blocked.html
 *    redeems the token for a trusted returnUrl.
 *
 * Design rule: the worker keeps NO authoritative state in memory.
 * chrome.storage.local is the single source of truth ("whytime.*" keys),
 * so the worker can be killed and restarted at any time. Deadlines are
 * epoch timestamps (plannedEndTime vs Date.now()), never timers.
 */

importScripts("common.js");
importScripts("wt-util.js");  // site-list sanitizing + boundary-safe matching + defaults
importScripts("wt-stats.js"); // 纯函数统计层：午夜拆分规则与日报共用同一实现

const browser = chrome;

const SETTINGS_KEY = "whytime.settings";
const ACTIVE_KEY = "whytime.activeSession";
const ARCHIVE_KEY = "whytime.sessions";
const LAST_ENDED_KEY = "whytime.lastEnded"; // 最近一次在本站"结束使用"的记忆
const BLOCK_CTX_KEY = "whytime.blockCtx";   // { ctxId: {returnUrl, host, at} }
const DAILY_KEY = "whytime.dailyUsage";     // { "YYYY-MM-DD": 当日累计秒 }
const HISTORY_MAX = 1000;                   // History 保留上限（超出删最旧）
// BLOCKED_PAGE 常量由 common.js 提供（LeechBlock 原有，值同为 "blocked.html"），
// SW 共享全局作用域里不允许重复声明。
const EXPIRE_ALARM = "whytime-expire";
const DISPOSE_ALARM = "whytime-dispose";
// 久坐强制拉伸休息（v0.13）：同一 Session 连续使用满 BREAK_AFTER_MIN 分钟，
// 强制跳转拉伸页（股四头肌 + 小腿，BREAK_MS），期间预算冻结、计时暂停。
const BREAK_AFTER_MIN = 40;
const BREAK_MS = 2 * 60 * 1000;
// 睡觉锁定（v0.16）：宵禁时段内受限网站一律指向睡觉页，无任何绕过入口
const CURFEW_ALARM = "whytime-curfew";
// 续时/开始理由的最近记录（滚动 3 条）：重复理由拒绝，让理由保有反思成本
const RECENT_REASONS_KEY = "whytime.recentReasons";
const RECENT_REASONS_MAX = 3;
// 目的对齐检查：active 期间每 10 分钟向当前活动标签页发一次检查，
// 由内容脚本弹窗询问"现在做的事和目的一致吗"。仅提醒不强制离场。
const CHECK_ALARM = "whytime-check";
const CHECK_INTERVAL_MIN = 10;
// 过期 Session 的归档宽限：给到期的"继续使用"承诺留操作窗口；
// 超过宽限仍未处理（用户离开），在下一次执行机会（本 alarm / 启动 / 各消息入口）
// 自动完成 settlement + archive（Phase v0.3 决策 #4）。
const DISPOSE_GRACE_MS = 30 * 60 * 1000;

// 计时条 ×（提前结束）后，blocked.html Ended 视图的轻量鼓励语。
// 描述语气，不做价值判断（§13）。
const ENCOURAGEMENTS = [
	"这次到这里，刚刚好。",
	"目的完成，就可以停下来。",
	"说到做到，这次就先结束。",
	"用到这里，已经够了。",
	"做完想做的事，就可以离开了。"
];

const PURPOSES = ["工作", "学习", "信息查询", "社交", "娱乐", "放松", "其他"];
const EXTEND_CHOICES = [5, 10, 20]; // minutes offered by the promise form
const MAX_MINUTES = 240;            // 自选时长上限（1 分钟起）
const MAX_BLOCK_CTXS = 20;          // 拦截上下文保留上限（防无限增长）
const REASON_MAX = 200;
// 结算宽限：到期检测最多允许迟到 5 分钟并如实计入；再往后视为离线（休眠/未开浏览器），
// 不把离线时长记成"已使用"。
const SETTLE_GRACE_MS = 5 * 60 * 1000;

function log(message) { console.log("[WhyTime] " + message); }
function warn(message) { console.warn("[WhyTime] " + message); }

// ---------- settings ----------

async function getSettings() {
	const got = await browser.storage.local.get(SETTINGS_KEY);
	const stored = got[SETTINGS_KEY];
	// key 不存在 → 用内置默认初始化一次并落盘（首次安装/存储被清）；
	// key 存在（哪怕名单为空）→ 原样生效，绝不把默认名单塞回去。
	if (stored === undefined) {
		const fresh = defaultSettings();
		await browser.storage.local.set({ [SETTINGS_KEY]: fresh });
		log("settings initialized: sites=" + fresh.sites);
		return fresh;
	}
	return resolveSettings(stored);
}

// ---------- storage helpers ----------

async function getActiveSession() {
	const got = await browser.storage.local.get(ACTIVE_KEY);
	const s = got[ACTIVE_KEY];
	return (s && typeof s === "object") ? s : null;
}

function setActiveSession(session) {
	return session
			? browser.storage.local.set({ [ACTIVE_KEY]: session })
			: browser.storage.local.remove(ACTIVE_KEY);
}

async function archiveSession(session) {
	const got = await browser.storage.local.get(ARCHIVE_KEY);
	const list = Array.isArray(got[ARCHIVE_KEY]) ? got[ARCHIVE_KEY] : [];
	list.push(session);
	// History 上限：只保留最近 HISTORY_MAX 条（超出删最旧）
	while (list.length > HISTORY_MAX) {
		list.shift();
	}
	await browser.storage.local.set({ [ARCHIVE_KEY]: list });
}

async function getLastEnded() {
	const got = await browser.storage.local.get(LAST_ENDED_KEY);
	const s = got[LAST_ENDED_KEY];
	return (s && typeof s === "object") ? s : null;
}

// 回合间冷静期（v0.12）：当天在同一受限站点的连续使用次数越多，
// 重新开始前需要等待的冷静期越长（2 分钟 × 次数，上限 10 分钟）。
// 动机：连续追剧时每次承诺都诚实，但摩擦力恒定会被习惯化——
// 缓冲必须随连续长度升级，把决定推迟到冲动峰值之后。
async function getGateInfo(host, now) {
	const got = await browser.storage.local.get(ARCHIVE_KEY);
	const list = Array.isArray(got[ARCHIVE_KEY]) ? got[ARCHIVE_KEY] : [];
	const today = dayKey(now);
	const mine = list.filter((s) => s && hostMatchesSite(host, s.domain)
			&& dayKey(s.startTime || 0) === today);
	const lastEnd = mine.reduce((m, s) => Math.max(m, sessionEndMs(s)), 0);
	const totalSecs = mine.reduce((sum, s) => sum + (s.actualSeconds || 0), 0);
	const todayExtCount = mine.reduce((sum, s) => sum + (s.extensionCount || 0), 0);
	let cooldownUntil = 0;
	if (mine.length > 0 && lastEnd > 0) {
		const cooldownMs = Math.min(10, 2 * mine.length) * 60000;
		if (now < lastEnd + cooldownMs) {
			cooldownUntil = lastEnd + cooldownMs;
		}
	}
	return {
		todayCount: mine.length,
		todaySiteSecs: totalSecs,
		todayExtCount: todayExtCount,
		cooldownUntil: cooldownUntil
	};
}

// 替代动作解析：altName/altUrl 按 | 拆分、按下标配对，URL 仅允许 http(s)
function parseAlt(settings) {
	const names = String(settings.altName || "").split("|").map(function (s) { return s.trim(); });
	const urls = String(settings.altUrl || "").split("|").map(function (s) { return s.trim(); });
	const list = [];
	for (let i = 0; i < names.length; i++) {
		if (!names[i]) {
			continue;
		}
		const url = urls[i] || "";
		list.push({
			name: names[i],
			url: /^https?:\/\//i.test(url) ? url : ""
		});
	}
	return list;
}

async function getRecentReasons() {
	const got = await browser.storage.local.get(RECENT_REASONS_KEY);
	const list = got[RECENT_REASONS_KEY];
	return Array.isArray(list) ? list : [];
}

// 记录一条已接受的理由（滚动 3 条）；返回是否与最近记录重复
async function checkAndPushReason(reason) {
	const recent = await getRecentReasons();
	if (recent.indexOf(reason) !== -1) {
		return false;
	}
	recent.push(reason);
	while (recent.length > RECENT_REASONS_MAX) {
		recent.shift();
	}
	await browser.storage.local.set({ [RECENT_REASONS_KEY]: recent });
	return true;
}

// 从 History 取回最近一条被 sweep 归档的过期 Session（用户明确要继续时）。
// 记录迁回运行时后从 History 中移除——Session 在 History 中至多一条。
async function resurrectExpiredForCtx(ctx) {
	if (!ctx || !ctx.host) {
		return null;
	}
	const got = await browser.storage.local.get(ARCHIVE_KEY);
	const list = Array.isArray(got[ARCHIVE_KEY]) ? got[ARCHIVE_KEY] : [];
	for (let i = list.length - 1; i >= 0; i--) {
		const s = list[i];
		if (s && s.endKind === "expiry" && hostMatchesSite(ctx.host, s.domain)) {
			list.splice(i, 1);
			await browser.storage.local.set({ [ARCHIVE_KEY]: list });
			return s;
		}
	}
	return null;
}

// ---------- block contexts（可信 returnUrl 令牌） ----------

async function getBlockCtxs() {
	const got = await browser.storage.local.get(BLOCK_CTX_KEY);
	const m = got[BLOCK_CTX_KEY];
	return (m && typeof m === "object") ? m : {};
}

async function getBlockCtx(ctxId) {
	if (!ctxId) {
		return null;
	}
	const map = await getBlockCtxs();
	return map[ctxId] || null;
}

// 签发拦截上下文：returnUrl 只在后台登记，绝不进入页面 URL。
async function issueBlockCtx(url) {
	const parsed = getParsedURL(getCleanURL(url || ""));
	const ctx = {
		id: "ctx-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
		returnUrl: parsed ? parsed.page : "",
		host: parsed ? parsed.host : "",
		at: Date.now()
	};
	const map = await getBlockCtxs();
	const entries = Object.entries(map).sort((a, b) => b[1].at - a[1].at);
	const pruned = {};
	for (const [id, c] of entries.slice(0, MAX_BLOCK_CTXS - 1)) {
		pruned[id] = c;
	}
	pruned[ctx.id] = ctx;
	await browser.storage.local.set({ [BLOCK_CTX_KEY]: pruned });
	return ctx;
}

// ---------- 阻断导航（统一由后台执行） ----------

// 把 tab 带到 blocked.html。chrome.tabs.update 不需要 tabs 权限
// （LeechBlock 的 applyBlock 同款做法），也规避了网页上下文直接
// 导航到扩展页的不可靠性。extras 会并入 ctx（如 encourage 文案）。
async function blockTab(tabId, url, extras) {
	const ctx = await issueBlockCtx(url);
	if (extras) {
		for (const k in extras) {
			ctx[k] = extras[k];
		}
	}
	const got = await browser.storage.local.get(BLOCK_CTX_KEY);
	const map = (got[BLOCK_CTX_KEY] && typeof got[BLOCK_CTX_KEY] === "object") ? got[BLOCK_CTX_KEY] : {};
	map[ctx.id] = ctx;
	await browser.storage.local.set({ [BLOCK_CTX_KEY]: map });
	const blockUrl = browser.runtime.getURL(BLOCKED_PAGE) + "?ctx=" + encodeURIComponent(ctx.id);
	if (tabId !== undefined && tabId !== null) {
		browser.tabs.update(tabId, { url: blockUrl }).catch(function (error) {
			warn("cannot navigate tab: " + error);
		});
	}
	return { action: "block", ctxId: ctx.id, blockUrl: blockUrl };
}

// ---------- daily usage（记账游标模型） ----------

// Today Usage 的唯一计算路径：结算点把 [usageAccountedUntil, 结算点] 的
// 墙钟区间累加进 whytime.dailyUsage。午夜拆分与日报共用 wt-stats 的
// splitUsageByDay（同一实现，一致性测试锁定）。游标幂等——刷新页面/
// 重复结算只会推进游标，绝不重复累加（§9）。页面只是读取方。

async function accountUsage(session, untilMs) {
	const from = (typeof session.usageAccountedUntil === "number")
			? session.usageAccountedUntil : session.startTime;
	if (!(untilMs > from)) {
		session.usageAccountedUntil = Math.max(from, untilMs);
		return;
	}
	const split = splitUsageByDay(from, untilMs);
	if (Object.keys(split).length) {
		const got = await browser.storage.local.get(DAILY_KEY);
		const usage = (got[DAILY_KEY] && typeof got[DAILY_KEY] === "object") ? got[DAILY_KEY] : {};
		for (const [key, secs] of Object.entries(split)) {
			usage[key] = (usage[key] || 0) + secs;
		}
		// 保留最近 ~4 个月，防止无限增长（key 为 YYYY-MM-DD，字典序即时间序）
		const keys = Object.keys(usage).sort();
		while (keys.length > 120) {
			delete usage[keys.shift()];
		}
		await browser.storage.local.set({ [DAILY_KEY]: usage });
	}
	session.usageAccountedUntil = untilMs;
}

async function getTodaySeconds() {
	const got = await browser.storage.local.get(DAILY_KEY);
	const usage = got[DAILY_KEY];
	return (usage && typeof usage === "object") ? (usage[dayKey(Date.now())] || 0) : 0;
}

// ---------- session lifecycle ----------

function newSession(parsed, site, reason, purpose, minutes, now, nextAction, perspective) {
	return {
		id: now.toString(36) + "-" + Math.random().toString(36).slice(2, 8),
		domain: site, // Session 身份 = configured site（主域名），子域/页面共用
		url: parsed.page,
		reason: reason,
		purpose: purpose,
		initialPlannedSeconds: minutes * 60, // 首次计划（不含续时），到期界面"原计划"用
		plannedSeconds: minutes * 60,        // 当前预算（含续时追加）
		startTime: now,
		plannedEndTime: now + (minutes * 60000),
		actualSeconds: 0,
		extensionCount: 0,
		extensions: [],                      // 每次续时的承诺记录 {reason, addMinutes, at}
		nextAction: nextAction || "",        // "做完这件事，接下来去"（v0.15 选填）
		perspective: !!perspective,          // "明天的你"视角作答（v0.16 必答）
		status: "active"
	};
}

// Settle a due session: active -> expired. Idempotent.
async function expireIfDue(session, now) {
	if (session && session.status === "active" && (now >= session.plannedEndTime)) {
		session.status = "expired";
		// Wall-clock accounting (Phase 1): actual usage capped at
		// deadline + settle grace so offline time is never billed.
		const billableEnd = Math.min(now, session.plannedEndTime + SETTLE_GRACE_MS);
		session.actualSeconds = Math.max(0, Math.round((billableEnd - session.startTime) / 1000));
		session.settledAt = billableEnd; // 到时结束的历史记录以此为 endTime
		await accountUsage(session, billableEnd); // 记入当日累计（游标幂等）
		await setActiveSession(session);
		// 归档宽限：给"继续使用"承诺留操作窗口（v0.3 决策 #4）
		browser.alarms.create(DISPOSE_ALARM, { when: session.settledAt + DISPOSE_GRACE_MS });
		log("session expired: " + session.id);
		return session;
	}
	return null;
}

function scheduleExpire(session) {
	browser.alarms.clear(EXPIRE_ALARM);
	browser.alarms.clear(DISPOSE_ALARM);
	browser.alarms.clear(CHECK_ALARM);
	if (session && session.status === "active") {
		browser.alarms.create(EXPIRE_ALARM, { when: session.plannedEndTime });
	}
}

// 目的对齐检查排程：间隔自适应——预算越长间隔越长（计划/4，收敛在 2–10 分钟）。
// 动机：短会话（如 15 分钟）用 10 分钟固定间隔时，任务提前完成后到检查之间的
// 空窗就成了刷别的东西的温床（v0.10.0 用户实测）；间隔随预算缩短可尽快递台阶。
function scheduleCheck(session) {
	browser.alarms.clear(CHECK_ALARM);
	if (session && session.status === "active") {
		const intervalMin = Math.min(10, Math.max(2, Math.ceil(session.plannedSeconds / 240)));
		browser.alarms.create(CHECK_ALARM, {
			when: Date.now() + (intervalMin * 60000),
			periodInMinutes: intervalMin
		});
	}
}

// 强制拉伸休息：预算顺延、暂停计费，Session 保持 active
async function startBreak(session, now) {
	await accountUsage(session, now); // 计费到暂停前一刻
	session.usageAccountedUntil = now + BREAK_MS; // 休息期间不计入
	session.plannedEndTime += BREAK_MS; // 预算顺延，不吃掉用户的时间
	session.breakUntil = now + BREAK_MS;
	(session.breaks = session.breaks || []).push({ at: now, until: session.breakUntil });
	await setActiveSession(session);
	scheduleExpire(session);
	log("stretch break: " + session.id + " until " + session.breakUntil);
	return session;
}

// 宵禁排程：在每次 Session 事件时重排；到点强制结束 + 全站指向睡觉页
function scheduleCurfew(settings) {
	browser.alarms.clear(CURFEW_ALARM);
	if (inCurfewWindow(settings, Date.now())) {
		browser.alarms.create(CURFEW_ALARM, { when: Date.now() + 15000 }); // 已在窗口内：15 秒内兜底强制
		return;
	}
	const parse = (s) => {
		const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
		return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : null;
	};
	const start = parse(settings.curfewStart);
	const end = parse(settings.curfewEnd);
	if (start === null || end === null || start === end) {
		return; // 宵禁关闭
	}
	const d = new Date();
	let next = new Date(d.getFullYear(), d.getMonth(), d.getDate(),
			Math.floor(start / 60), start % 60, 0, 0).getTime();
	const inWindow = (start < end) ? false : (d.getHours() * 60 + d.getMinutes()) >= start;
	if (next <= Date.now() || inWindow) {
		next += 24 * 3600 * 1000; // 今天已过/在窗口（窗口内已由上面 15 秒兜底）→ 明天同一时刻
	}
	browser.alarms.create(CURFEW_ALARM, { when: next });
}

// 宵禁到点：强制结束进行中的 Session（endKind = curfew），广播全站去睡觉页
async function enforceCurfew() {
	const settings = await getSettings();
	if (!inCurfewWindow(settings, Date.now())) {
		return { enforced: false };
	}
	const session = await getActiveSession();
	if (session && session.status === "active") {
		await endSessionInternal(Date.now(), "curfew");
	}
	const tabs = await browser.tabs.query({});
	for (const tab of tabs) {
		browser.tabs.sendMessage(tab.id, { type: "curfew-start" }).catch(function (error) {});
	}
	return { enforced: true };
}

// 统一归档路径：把已结算（expired）的 Session 写入 History 并回到
// "无运行中 Session" 状态。end-session 与 dispose sweep 共用。
async function disposeExpiredSession(session, now) {
	session.endKind = "expiry";
	session.endTime = session.settledAt || now;
	session.status = "ended"; // History 中的记录一律为已结束，原因看 endKind
	await archiveSession(session);
	await browser.storage.local.set({
		[LAST_ENDED_KEY]: { domain: session.domain, id: session.id, at: now }
	});
	await setActiveSession(null);
	scheduleExpire(null);
	log("session archived (expiry): " + session.id);
	return session;
}

// Sweep：WhyTime 的每个执行机会都先走一遍，保证被放弃的过期 Session
// 最终必然进入 History（宽限期内保留以完成承诺流程）。
async function sweepStaleSession() {
	const session = await getActiveSession();
	if (!session) {
		return null;
	}
	if (session.status === "active" && (Date.now() >= session.plannedEndTime)) {
		return await expireIfDue(session, Date.now());
	}
	if (session.status === "expired" && session.settledAt
			&& (Date.now() - session.settledAt) >= DISPOSE_GRACE_MS) {
		return await disposeExpiredSession(session, Date.now());
	}
	return null;
}

// 通知所有 tab：Session 已到期。各 tab 上的 content script 会用自己
// 当前的 URL 请求 go-blocked，由后台带各自的 returnUrl 去 blocked.html。
async function broadcastExpired(session) {
	const tabs = await browser.tabs.query({});
	for (const tab of tabs) {
		browser.tabs.sendMessage(tab.id, { type: "session-expired" }).catch(function (error) {});
	}
}

// ---------- message handling ----------

async function handleMessage(message, sender) {
	const now = Date.now();

	switch (message.type) {

		case "hello": {
			// Content script loaded: verdict for this page.
			await sweepStaleSession(); // 每个执行机会先清账（宽限期外的过期 Session 归档）
			const url = message.url || sender.url || "";
			const { settings, parsed, matched } = await matchGate(url);
			scheduleCurfew(settings);
			if (!matched) {
				return { action: "allow" };
			}
			if (inCurfewWindow(settings, now)) {
				// 睡觉锁定：宵禁时段受限网站一律指向睡觉页（先于一切 Session 状态）
				let active = await getActiveSession();
				if (active && active.status === "active") {
					await endSessionInternal(now, "curfew");
				}
				return await blockTab(sender.tab ? sender.tab.id : null, url, { curfew: true });
			}

			let session = await getActiveSession();
			const expired = await expireIfDue(session, now);
			if (expired) {
				await broadcastExpired(expired);
			}
			session = expired || session;

			if (session && session.status === "active"
					&& hostMatchesSite(parsed.host, session.domain)) {
				// URL 改变不等于 Session 改变：子域跳转沿用同一个 Session。
				if (session.breakUntil) {
					if (now < session.breakUntil) {
						// 强制休息未完成：送回拉伸页
						return await blockTab(sender.tab ? sender.tab.id : null, url,
								{ breakUntil: session.breakUntil });
					}
					session.breakMark = session.breakUntil; // 下一个 40 分钟从休息结束起算
					delete session.breakUntil;
					await setActiveSession(session);
				}
				return { action: "allow", session: session };
			}
			// 命中受限网站且没有可用 Session：由后台带去 blocked.html。
			return await blockTab(sender.tab ? sender.tab.id : null, url);
		}

		case "expire-check": {
			// Content script's local deadline hit; settle if due (idempotent),
			// then move this tab to blocked.html.
			const session = await getActiveSession();
			const expired = await expireIfDue(session, now);
			if (expired) {
				await broadcastExpired(expired);
				const url = sender.url || message.url || "";
				return await blockTab(sender.tab ? sender.tab.id : null, url);
			}
			return { action: "allow", session: session };
		}

		case "go-blocked": {
			// A tab heard the expiry broadcast and asks to be taken away.
			const url = message.url || sender.url || "";
			const { matched } = await matchGate(url);
			if (!matched) {
				return { action: "allow" };
			}
			return await blockTab(sender.tab ? sender.tab.id : null, url);
		}

		case "block-context": {
			// blocked.html redeems its ctx token for a trusted render context.
			// The VIEW is always derived from live state; ctx only supplies
			// the validated returnUrl.
			const ctx = await getBlockCtx(message.ctxId);
			if (!ctx) {
				return { view: "invalid" };
			}
			await sweepStaleSession(); // 每个执行机会先清账
			const settings = await getSettings();
			if (inCurfewWindow(settings, Date.now())) {
				let active = await getActiveSession();
				if (active && active.status === "active") {
					await endSessionInternal(Date.now(), "curfew");
				}
				return {
					view: "sleep",
					curfewStart: settings.curfewStart,
					curfewEnd: settings.curfewEnd,
					returnUrl: ctx.returnUrl
				};
			}
			let session = await getActiveSession();
			const expired = await expireIfDue(session, Date.now());
			if (expired) {
				await broadcastExpired(expired);
			}
			session = expired || session;

			// 若有仍在进行的 Session，把它的墙钟用量记账到当前时刻
			//（游标幂等，多次读取不会重复累加）。
			if (session && session.status === "active") {
				await accountUsage(session, Date.now());
				await setActiveSession(session);
			}
			const todaySeconds = await getTodaySeconds();

			if (session && session.status === "expired"
					&& hostMatchesSite(ctx.host, session.domain)) {
				const gateInfoExp = await getGateInfo(ctx.host, Date.now());
				return {
					view: "expired",
					session: session,
					maxExtensions: settings.maxExtensions,
					durations: settings.durations,
					todaySeconds: todaySeconds,
					todayExtCount: gateInfoExp.todayExtCount + (session.extensionCount || 0),
					altList: parseAlt(settings),
					returnUrl: ctx.returnUrl
				};
			}
			if (session && session.status === "active" && session.breakUntil
					&& hostMatchesSite(ctx.host, session.domain)) {
				// 强制拉伸休息进行中
				return {
					view: "break",
					session: session,
					todaySeconds: todaySeconds,
					returnUrl: ctx.returnUrl
				};
			}
			if (session && session.status === "active"
					&& hostMatchesSite(ctx.host, session.domain)) {
				return {
					view: "active",
					session: session,
					todaySeconds: todaySeconds,
					returnUrl: ctx.returnUrl
				};
			}
			const lastEnded = await getLastEnded();
			if (lastEnded && hostMatchesSite(ctx.host, lastEnded.domain)) {
				return {
					view: "ended",
					durations: settings.durations,
					todaySeconds: todaySeconds,
					encourage: ctx.encourage || null,
					savedMin: (typeof ctx.savedMin === "number") ? ctx.savedMin : 0,
					gateInfo: await getGateInfo(ctx.host, Date.now()),
					altList: parseAlt(settings),
					returnUrl: ctx.returnUrl
				};
			}
			return {
				view: "gate",
				durations: settings.durations,
				todaySeconds: todaySeconds,
				gateInfo: await getGateInfo(ctx.host, Date.now()),
				returnUrl: ctx.returnUrl
			};
		}

		case "start-session": {
			// 来自 blocked.html 的承诺提交：Session 的 URL 取自 ctx.returnUrl
			//（可信），绝不取 blocked.html 自己的地址。
			const ctx = await getBlockCtx(message.ctxId);
			if (!ctx) {
				return { type: "error", message: "拦截上下文无效，请刷新重试" };
			}
			await sweepStaleSession(); // 先归档已放弃的过期 Session，再开新的
			const gate = await matchGate(ctx.returnUrl);
			const settings = gate.settings;
			const parsed = gate.parsed;
			if (!gate.matched || !gate.site) {
				return { type: "error", message: "该网站不在名单中" };
			}

			const existing = await getActiveSession();
			if (existing) {
				if (hostMatchesSite(parsed.host, existing.domain)) {
					// 幂等：这个站点已有 Session（可能是双击/重复提交）。
					return (existing.status === "active")
							? { type: "resume-active", session: existing, returnUrl: ctx.returnUrl }
							: {
								type: "resume-expired",
								session: existing,
								maxExtensions: settings.maxExtensions,
								returnUrl: ctx.returnUrl
							};
				}
				return { type: "gate-conflict", domain: existing.domain };
			}

			// 回合间冷静期：同站连续使用次数越多，重新开始前等待越久（SW 强制，UI 只是投影）
			const gateInfo = await getGateInfo(parsed.host, now);
			if (gateInfo.cooldownUntil > now) {
				const waitSecs = Math.ceil((gateInfo.cooldownUntil - now) / 1000);
				return {
					type: "error",
					message: "冷静期：还需等待 " + waitSecs + " 秒（今天第 "
							+ gateInfo.todayCount + " 次使用了，缓冲一下再决定）"
				};
			}

			const minutes = +message.plannedMinutes;
			const reason = String(message.reason || "").trim().slice(0, REASON_MAX);
			const purpose = (PURPOSES.indexOf(message.purpose) >= 0) ? message.purpose : "其他";
			if (!reason
					|| !Number.isInteger(minutes)
					|| minutes < 1 || minutes > MAX_MINUTES) {
				return { type: "error", message: "请填写原因并选择时长（1-" + MAX_MINUTES + " 分钟）" };
			}
			if (inCurfewWindow(settings, Date.now())) {
				return { type: "error", message: "现在是睡觉时间（" + settings.curfewStart
						+ "–" + settings.curfewEnd + "），明天再来吧" };
			}
			// 接下来要做的事必填（v0.15.1）：堵住"做完之后"的空白
			const nextAction = String(message.nextAction || "").trim().slice(0, 60);
			if (!nextAction) {
				return { type: "error", message: "请填写接下来要做的事" };
			}
			// 理由保有反思成本：与最近 3 条相同则拒绝（v0.14）
			if (typeof message.perspective !== "boolean") {
				return { type: "error", message: "请回答\"明天的你\"的问题" };
			}
			if (!(await checkAndPushReason(reason))) {
				return { type: "error", message: "换个理由试试——这个你刚用过" };
			}

			const session = newSession(parsed, gate.site, reason, purpose, minutes, now, nextAction, message.perspective === true);
			await setActiveSession(session);
			scheduleExpire(session);
			scheduleCheck(session);
			scheduleCurfew(settings);
			log("session started: " + session.id + " " + session.domain + " " + minutes + "m");
			return { type: "session-started", session: session, returnUrl: ctx.returnUrl };
		}

		case "extend-session": {
			// 二次承诺：SW 强制校验续时原因与次数上限（UI 只是入口，不是守门人）。
			const ctx = await getBlockCtx(message.ctxId);
			if (!ctx) {
				return { type: "error", message: "拦截上下文无效，请刷新重试" };
			}
			const settings = await getSettings();
			let session = await getActiveSession();
			let resurrected = false;
			if (!session) {
				// Sweep 可能已把宽限期外的过期 Session 归档；用户此时明确要继续，
				// 把它从 History 取回（迁回运行时，History 中不再保留该条）。
				// 注意：取回时保持 expired 原状，续时成功后才置 active 并排程。
				const revived = await resurrectExpiredForCtx(ctx);
				if (!revived) {
					return { type: "error", message: "没有进行中的使用" };
				}
				await setActiveSession(revived);
				session = revived;
				resurrected = true;
				log("session resurrected from history: " + session.id);
			}
			if (session.status === "active" && !resurrected) {
				return { type: "resume-active", session: session, returnUrl: ctx.returnUrl };
			}
			if (session.status !== "expired" && !resurrected) {
				return { type: "error", message: "当前状态无法续时" };
			}
			if (inCurfewWindow(settings, Date.now())) {
				return { type: "error", message: "现在是睡觉时间（" + settings.curfewStart
						+ "–" + settings.curfewEnd + "），明天再来吧" };
			}
			if (session.extensionCount >= settings.maxExtensions) {
				return { type: "extend-denied", session: session, maxExtensions: settings.maxExtensions };
			}
			const add = EXTEND_CHOICES.indexOf(+message.addMinutes) >= 0 ? +message.addMinutes : 0;
			if (!add) {
				return { type: "error", message: "无效的续时时长" };
			}
			const reason = String(message.reason || "").trim().slice(0, REASON_MAX);
			if (!reason) {
				return { type: "error", message: "请填写继续原因" };
			}
			if (typeof message.perspective !== "boolean") {
				return { type: "error", message: "请回答\"明天的你\"的问题" };
			}
			if (!(await checkAndPushReason(reason))) {
				return { type: "error", message: "换个理由试试——这个你刚用过" };
			}

			session.extensionCount += 1;
			session.plannedSeconds += (add * 60);
			session.plannedEndTime = now + (add * 60000); // 从当下重新起算
			session.status = "active";
			(session.extensions = session.extensions || []).push({
				reason: reason,
				addMinutes: add,
				at: now,
				perspective: !!message.perspective
			});
			await setActiveSession(session);
			scheduleExpire(session);
			scheduleCheck(session);
			scheduleCurfew(settings);
			log("session extended: " + session.id + " +" + add + "m (#" + session.extensionCount + ")");
			return {
				type: "session-extended",
				session: session,
				maxExtensions: settings.maxExtensions,
				returnUrl: ctx.returnUrl
			};
		}

		case "end-session": {
			const ctx = await getBlockCtx(message.ctxId);
			if (!ctx) {
				return { type: "error", message: "拦截上下文无效，请刷新重试" };
			}
			const settings = await getSettings();
			const session = await endSessionInternal(now);
			if (!session) {
				return { type: "session-ended", session: null }; // already archived elsewhere
			}
			return {
				type: "session-ended",
				session: session,
				todaySeconds: await getTodaySeconds(),
				gateInfo: await getGateInfo(ctx.host, now),
				altList: parseAlt(settings)
			};
		}

		case "end-active": {
			// 计时条 ×：用户主动提前结束。复用 end-session 的统一归档路径
			//（endSessionInternal），content 侧不触碰任何存储。
			const url = message.url || sender.url || "";
			const session = await getActiveSession();
			if (!session) {
				return { action: "allow" }; // 无进行中的使用（竞态），页面原样
			}
			const parsed = getParsedURL(getCleanURL(url));
			if (!parsed || !parsed.host
					|| !hostMatchesSite(parsed.host, session.domain)) {
				return { action: "allow" }; // 当前页面不属于该 Session 的站点
			}
			const ended = await endSessionInternal(now);
			if (!ended) {
				return { action: "allow" };
			}
			// 提前结束 = 本次使用正式结束：离开原网站，Ended 视图附鼓励语与"省下的时间"
			const encourage = ENCOURAGEMENTS[Math.floor(Math.random() * ENCOURAGEMENTS.length)];
			const savedMin = Math.max(0, Math.round((ended.plannedSeconds - ended.actualSeconds) / 60));
			return await blockTab(sender.tab ? sender.tab.id : null, url,
					{ encourage: encourage, savedMin: savedMin });
		}

		case "intention-answer": {
			// 定期目的对齐检查的作答。background 唯一写入者：checkIns 记在 Session 上。
			const url = sender.url || message.url || "";
			const session = await getActiveSession();
			if (!session || session.status !== "active") {
				return { action: "allow" }; // 竞态：已结算
			}
			const parsed = getParsedURL(getCleanURL(url));
			if (!parsed || !parsed.host
					|| !hostMatchesSite(parsed.host, session.domain)) {
				return { action: "allow" };
			}
			const entry = { at: now, consistent: !!message.consistent };
			if (message.action === "continue") {
				entry.action = "continue";
				entry.reason = String(message.reason || "").trim().slice(0, REASON_MAX);
				if (!entry.reason) {
					return { type: "error", message: "请填写偏离原因" };
				}
			} else if (message.action === "end") {
				entry.action = "end";
			}
			(session.checkIns = session.checkIns || []).push(entry);
			await setActiveSession(session);
			log("intention check: " + session.id + " consistent=" + entry.consistent
					+ (entry.reason ? " reason=" + entry.reason : ""));
			if (message.action === "end") {
				// 不想继续了：走统一归档路径，离开原网站进 Ended
				const ended = await endSessionInternal(now);
				if (!ended) {
					return { action: "allow" };
				}
				const encourage = ENCOURAGEMENTS[Math.floor(Math.random() * ENCOURAGEMENTS.length)];
				const savedMin = Math.max(0, Math.round((ended.plannedSeconds - ended.actualSeconds) / 60));
				return await blockTab(sender.tab ? sender.tab.id : null, url,
						{ encourage: encourage, savedMin: savedMin });
			}
			return { action: "dismiss" };
		}

		case "stretch-break": {
			// 久坐强制拉伸：内容脚本到点上报或 alarm 广播后的响应，SW 复核后带去拉伸页
			const url = sender.url || message.url || "";
			const session = await getActiveSession();
			if (!session || session.status !== "active"
					|| (Date.now() - (session.breakMark || session.startTime))
						< (BREAK_AFTER_MIN * 60000)) {
				return { action: "allow" };
			}
			const parsed = getParsedURL(getCleanURL(url));
			if (!parsed || !parsed.host
					|| !hostMatchesSite(parsed.host, session.domain)) {
				return { action: "allow" };
			}
			await startBreak(session, Date.now());
			return await blockTab(sender.tab ? sender.tab.id : null, url,
					{ breakUntil: session.breakUntil });
		}

		case "break-done": {
			// 拉伸完成：解除休息状态，回到原网站（预算已在开始休息时顺延）
			const ctx = await getBlockCtx(message.ctxId);
			if (!ctx) {
				return { type: "error", message: "拦截上下文无效，请刷新重试" };
			}
			const session = await getActiveSession();
			if (!session || session.status !== "active" || !session.breakUntil) {
				return { type: "error", message: "当前不在休息状态" };
			}
			if (Date.now() < session.breakUntil) {
				return { type: "error", message: "还在休息倒计时中，站起来活动一下" };
			}
			session.breakMark = session.breakUntil;
			delete session.breakUntil;
			await setActiveSession(session);
			scheduleExpire(session);
			log("break done: " + session.id);
			return { type: "break-done", returnUrl: ctx.returnUrl };
		}

		case "deviation-review": {
			// 到期后的偏离回顾（blocked.html Expired 视图）。落到 Session 上随归档进 History/CSV。
			const ctx = await getBlockCtx(message.ctxId);
			if (!ctx) {
				return { type: "error", message: "拦截上下文无效，请刷新重试" };
			}
			const session = await getActiveSession();
			if (!session || session.status !== "expired") {
				return { type: "error", message: "当前没有待回顾的使用" };
			}
			const deviated = !!message.deviated;
			const reason = String(message.reason || "").trim().slice(0, REASON_MAX);
			if (deviated && !reason) {
				return { type: "error", message: "请写一下偏离的内容和原因" };
			}
			session.deviationReview = { at: now, deviated: deviated, reason: reason };
			await setActiveSession(session);
			log("deviation review: " + session.id + " deviated=" + deviated);
			return { ok: true, session: session };
		}

		case "curfew-check": {
			// 宵禁广播的响应：内容脚本自报 URL，SW 复核名单与窗口后带去睡觉页
			const url = sender.url || message.url || "";
			const settings = await getSettings();
			const parsed = getParsedURL(getCleanURL(url));
			if (!parsed || !parsed.host
					|| !urlMatchesSiteList(parsed.page, sanitizeSiteInput(settings.sites).sites)
					|| !inCurfewWindow(settings, Date.now())) {
				return { action: "allow" };
			}
			return await blockTab(sender.tab ? sender.tab.id : null, url, { curfew: true });
		}

		case "history-get": {
			// 使用记录 / 数据分析页取数。先清账，保证滞留的过期 Session 入档。
			await sweepStaleSession();
			const got = await browser.storage.local.get(ARCHIVE_KEY);
			const list = Array.isArray(got[ARCHIVE_KEY]) ? got[ARCHIVE_KEY] : [];
			return { sessions: list, cap: HISTORY_MAX };
		}

		case "history-clear": {
			// 只清 History 与每日账本；activeSession / settings / lastEnded /
			// blockCtx 一律不动（进行中的使用不受影响）。
			await browser.storage.local.remove(ARCHIVE_KEY);
			await browser.storage.local.remove(DAILY_KEY);
			await browser.storage.local.remove(RECENT_REASONS_KEY);
			log("history cleared");
			return { ok: true };
		}

	}

	return { type: "unknown", requestType: message.type };
}

// 统一结束路径：end-session（blocked.html）/ end-active（计时条 ×）/ 宵禁强制共用。
// forcedEndKind 可选（"curfew"）：宵禁到点强制结束活跃 Session 时的结束方式标记。
// 幂等——无 activeSession 时返回 null，不产生第二条 History。
async function endSessionInternal(now, forcedEndKind) {
	let session = await getActiveSession();
	if (!session) {
		return null;
	}
	session = (await expireIfDue(session, now)) || session;
	const endKind = forcedEndKind
			|| ((session.status === "expired") ? "expiry" : "user");
	if (endKind !== "expiry") {
		// Ended by the user before expiry: wall-clock seconds so far.
		session.actualSeconds = Math.max(0, Math.round((now - session.startTime) / 1000));
		await accountUsage(session, now); // 记入当日累计（游标幂等）
	}
	session.endKind = endKind;
	session.endTime = (endKind === "expiry" && session.settledAt) ? session.settledAt : now;
	session.status = "ended"; // History 中的记录一律为已结束，原因看 endKind
	await archiveSession(session);
	// ended ≠ 解除限制：blocked.html 保持 Ended 状态，不返回原网站。
	await browser.storage.local.set({
		[LAST_ENDED_KEY]: { domain: session.domain, id: session.id, at: now }
	});
	await setActiveSession(null);
	scheduleExpire(null);
	// 通知所有 tab（其他同站 tab 的计时条也要离开并转入 blocked）
	const tabs = await browser.tabs.query({});
	for (const tab of tabs) {
		browser.tabs.sendMessage(tab.id, { type: "session-ended" }).catch(function (error) {});
	}
	log("session ended (" + endKind + "): " + session.id + " actual=" + session.actualSeconds + "s");
	return session;
}

// Test a page URL against the user's gated-site list.
// Returns { settings, parsed, matched, site }.
async function matchGate(url) {
	const settings = await getSettings();
	const parsed = getParsedURL(getCleanURL(url || ""));
	if (!parsed || !parsed.host
			|| !/^https?$/.test(parsed.protocol || "")
			|| !settings.sites) {
		return { settings, parsed, matched: false };
	}
	// sanitizeSiteInput 是 WhyTime 的输入清洗层；siteListMatches 组合两类条目：
	// 含点号 → 域名边界匹配；不含点号 → 主机名关键词匹配（宽松，见 wt-util 注释）。
	const siteList = sanitizeSiteInput(settings.sites).sites;
	const matched = !!siteList.length && siteListMatches(parsed.page, parsed.host, siteList);
	// Session 身份：命中的 configured site / 关键词（不是入口页 host，也不是 returnUrl）
	const site = matched ? matchConfiguredSite(parsed.host, siteList) : null;
	return { settings, parsed, matched, site };
}

// ---------- event wiring ----------

// Serialize message handling: two near-simultaneous requests (e.g. a
// double-clicked button, or two tabs racing) must not both read the same
// pre-write state from storage.
var gHandleQueue = Promise.resolve();

browser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
	const run = gHandleQueue.then(function () {
		return handleMessage(message, sender);
	});
	gHandleQueue = run.catch(function (error) {});
	run.then(sendResponse).catch(function (error) {
		warn("handler error: " + error);
		sendResponse({ type: "error", message: "内部错误，请重试" });
	});
	return true; // keep the message channel open for the async response
});

browser.alarms.onAlarm.addListener(async function (alarm) {
	if (alarm.name === EXPIRE_ALARM) {
		const session = await getActiveSession();
		const expired = await expireIfDue(session, Date.now());
		if (expired) {
			await broadcastExpired(expired);
		}
	} else if (alarm.name === CHECK_ALARM) {
		const settings = await getSettings();
		if (inCurfewWindow(settings, Date.now())) {
			await enforceCurfew();
			return;
		}
		// 到点先判久坐强制休息，再判目的对齐检查；都发给当前聚焦窗口的活动标签页
		const session = await getActiveSession();
		if (!session || session.status !== "active") {
			return;
		}
		const dueBreak = (Date.now() - (session.breakMark || session.startTime))
				>= (BREAK_AFTER_MIN * 60000);
		const kind = dueBreak ? "stretch-break" : "intention-check";
		const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
		for (const tab of tabs) {
			browser.tabs.sendMessage(tab.id, {
				type: kind,
				elapsedMin: Math.round((Date.now() - session.startTime) / 60000)
			}).catch(function (error) {});
		}
	} else if (alarm.name === CURFEW_ALARM) {
		await enforceCurfew();
	} else if (alarm.name === DISPOSE_ALARM) {
		// 归档宽限到期：被放弃的过期 Session 进入统一归档路径
		await sweepStaleSession();
	}
});

browser.runtime.onStartup.addListener(async function () {
	// 浏览器重启 = 承诺流程必然中断：滞留的过期 Session 直接归档
	await sweepStaleSession();
	scheduleCurfew(await getSettings());
});

browser.runtime.onInstalled.addListener(async function () {
	const got = await browser.storage.local.get(SETTINGS_KEY);
	// 仅 key 不存在时初始化默认（sites 为空的用户配置不会被覆盖）
	if (got[SETTINGS_KEY] === undefined) {
		await browser.storage.local.set({ [SETTINGS_KEY]: defaultSettings() });
		log("default settings initialized: " + DEFAULT_SITES.join(", "));
	}
	scheduleCurfew(await getSettings());
});

browser.runtime.onStartup.addListener(async function () {
	scheduleCurfew(await getSettings());
});
