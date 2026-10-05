/* WhyTime shared utilities (new WhyTime code, not from LeechBlock).
 * Depends on common.js (LeechBlock engine) being loaded first.
 *
 * Two jobs:
 * 1. sanitizeSiteInput — normalize user-entered site lists BEFORE the
 *    LeechBlock engine sees them (zero-width chars, full-width letters,
 *    LBNG-only prefixes), which cleanSites() alone passes through.
 * 2. Site matching glue — WhyTime list semantics: a listed domain ALWAYS
 *    covers its subdomains (bilibili.com ≡ www/message/space.bilibili.com),
 *    and a host boundary assertion is added on top of the engine output,
 *    because the engine's block regexp is not right-anchored and would
 *    otherwise match "bilibili.com.example.com". No engine code is
 *    modified — the lookahead is appended to the engine's regexp string.
 */

function sanitizeSiteInput(raw) {
	const tokens = String(raw == null ? "" : raw)
		.normalize("NFKC")                                  // 全角字母/数字/空格 → 半角
		.toLowerCase()
		.split(/[\s\u200B\u200C\u200D\u2060\uFEFF]+/)       // 所有空白 + 零宽字符
		.map(function (t) { return t.replace(/^[+>~]/, ""); })   // LBNG 的 +/>/~ 在 WhyTime 无语义，保留会静默失效
		.map(function (t) { return t.replace(/^https?:\/\//, ""); })
		.filter(Boolean);

	const seen = Object.create(null);
	const sites = [];
	for (const t of tokens) {
		if (!seen[t]) {
			seen[t] = true;
			sites.push(t);
		}
	}
	return { sites: sites, display: sites.join("\n") };
}

// ---------- 默认配置（单一事实来源：background / options / 测试都用这里） ----------

// 内置默认限制地址。必须是 site pattern（hostname 形式，§7），
// 不是完整 URL；子域由匹配层自动覆盖（www/message/space/passport 同规则）。
const DEFAULT_SITES = ["bilibili.com"];

function defaultSettings() {
	return {
		sites: DEFAULT_SITES.join(" "),
		durations: [5, 10, 15, 20, 30, 45, 60], // 快捷档位（15 为 v0.15 新增）；自选时长 1-240 由 UI 提供
		maxExtensions: 0, // 默认不允许续时（2026-10-03 用户决定）；需要时在设置里改
		// 替代动作（v0.14）：| 分隔多条，渲染时随机取一条；清空名称=关闭建议
		altName: "阅读|运动",
		altUrl: "https://weread.qq.com/web|",
		curfewStart: "22:00",
		curfewEnd: "06:00"
	};
}

// 默认值与用户配置的语义分界（§5）：
//   stored === undefined（key 不存在）        → 使用默认（首次安装初始化）
//   stored 存在（哪怕 sites 为空字符串）      → 原样生效，绝不复活默认
// 因此禁止 sites || DEFAULT_SITES 这类写法——空名单是用户的明确选择。
function resolveSettings(stored) {
	if (!stored || typeof stored !== "object") {
		return defaultSettings();
	}
	const d = defaultSettings();
	return {
		// 域名/关键词统一小写：host 大小写不敏感，存储里的任何大小写在读取时归一
		sites: (typeof stored.sites === "string") ? stored.sites.toLowerCase() : "",
		durations: (Array.isArray(stored.durations) && stored.durations.length)
				? stored.durations.slice() : d.durations,
		maxExtensions: Number.isInteger(stored.maxExtensions)
				? Math.max(0, Math.min(9, stored.maxExtensions)) : d.maxExtensions,
		// 替代动作：字符串按原样保留（允许清空=关闭建议），缺失回退默认
		altName: (typeof stored.altName === "string") ? stored.altName : d.altName,
		altUrl: (typeof stored.altUrl === "string") ? stored.altUrl : d.altUrl,
		// 睡觉锁定（v0.16）：HH:MM 字符串，start===end 视为关闭
		curfewStart: (typeof stored.curfewStart === "string" && stored.curfewStart) ? stored.curfewStart : d.curfewStart,
		curfewEnd: (typeof stored.curfewEnd === "string" && stored.curfewEnd) ? stored.curfewEnd : d.curfewEnd
	};
}

// Build the WhyTime block regexp for a site list (string or array).
// Subdomain matching is always on; host boundary is asserted with a
// lookahead so only [/:?# or end] may follow the matched host.
// 仅用于"含点号的域名条目"——裸关键词（不含点号）走关键词匹配。
function siteRegExp(sites) {
	const list = Array.isArray(sites) ? sites.join(" ") : sites;
	if (!list) {
		return null;
	}
	const re = getRegExpSites(cleanSites(list), true).block;
	return re ? new RegExp(re + "(?=[/:?#]|$)", "i") : null;
}

// 名单条目分两类（v0.9 匹配语义）：
//   含点号   → 域名条目：边界安全匹配（bilibili.com 覆盖全部子域，
//              不误伤 notbilibili.com / bilibili.com.example.com）
//   不含点号 → 关键词条目：主机名包含该词即命中（bilibili 覆盖
//              bilibili.com/.tv/任意后缀；代价是 notbilibili.com 也会命中，
//              这是"包含即命中"语义的固有宽松性，见交付说明）
function splitSiteEntries(sites) {
	const list = Array.isArray(sites) ? sites : sanitizeSiteInput(sites).sites;
	const domains = [];
	const keywords = [];
	for (const s of list) {
		if (!s) {
			continue;
		}
		if (s.indexOf(".") !== -1) {
			domains.push(s);
		} else {
			keywords.push(s);
		}
	}
	return { domains: domains, keywords: keywords };
}

// 组合匹配：完整 URL 命中域名条目，或主机名包含任一关键词条目。
function siteListMatches(url, host, sites) {
	const parts = splitSiteEntries(sites);
	if (parts.domains.length && urlMatchesSiteList(url, parts.domains)) {
		return true;
	}
	if (host && parts.keywords.length) {
		const h = host.toLowerCase();
		for (const kw of parts.keywords) {
			if (h.indexOf(kw) !== -1) {
				return true;
			}
		}
	}
	return false;
}

// 睡觉锁定窗口判断（纯函数，供 SW/设置页/测试共用）。
// start===end 视为关闭；支持跨午夜（22:00-06:00）。
function inCurfewWindow(settings, nowMs) {
	const parse = (s) => {
		const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
		return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : null;
	};
	const start = parse(settings.curfewStart);
	const end = parse(settings.curfewEnd);
	if (start === null || end === null || start === end) {
		return false;
	}
	const d = new Date(nowMs);
	const mins = d.getHours() * 60 + d.getMinutes();
	return (start < end) ? (mins >= start && mins < end)
			: (mins >= start || mins < end);
}

// Does a full page URL hit the site list?（仅域名条目；组合匹配用 siteListMatches）
function urlMatchesSiteList(url, sites) {
	const re = siteRegExp(sites);
	return !!re && re.test(url);
}

// Does a host belong to one listed site (the session-owner check)?
// "http://" prefix reuses the engine's scheme-anchored regexp unchanged.
// 不含点号的条目按关键词判断（与 siteListMatches 同一语义）。
function hostMatchesSite(host, site) {
	if (!host || !site) {
		return false;
	}
	if (site.indexOf(".") === -1) {
		return host.toLowerCase().indexOf(site.toLowerCase()) !== -1;
	}
	const re = siteRegExp([site]);
	return !!re && re.test("http://" + host + "/");
}

// Resolve WHICH configured site a host belongs to (longest match wins,
// 例如名单同时有 bilibili.com 与 space.bilibili.com 时取更具体者）。
// Session identity = configured site——不是入口页 host，也不是 returnUrl。
// sites 参数为已规范化的站点数组。
function matchConfiguredSite(host, sites) {
	if (!host || !Array.isArray(sites)) {
		return null;
	}
	let best = null;
	for (const site of sites) {
		if (site && hostMatchesSite(host, site)) {
			if (!best || site.length > best.length) {
				best = site;
			}
		}
	}
	// Session 身份恒为小写（输入侧可能残留大写条目）
	return best ? best.toLowerCase() : null;
}
