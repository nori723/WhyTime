/* WhyTime stats (pure functions, no chrome.* dependency).
 *
 * Loaded by: background (split rule for the usage ledger), history.html
 * (all reporting), tests. Everything here is deterministic: same input,
 * same output, no storage access.
 *
 * Facts live in whytime.sessions (Session History, canonical).
 * whytime.dailyUsage is an engine-maintained ledger/cache — the report
 * layer never reads it, and a consistency test asserts both agree.
 *
 * Day attribution rules (v0.4, documented):
 *   - 实际使用时间：按本地午夜把 [startTime, endTime] 的墙钟秒数切分归日；
 *     与结算引擎 accountUsage 的拆分完全同一实现（splitUsageByDay）。
 *   - 计划时间 / 打开次数 / 续时次数：归属 Session 的开始日。
 */

function pad2(n) {
	return ((n < 10) ? "0" : "") + n;
}

function dayKey(ms) {
	const d = new Date(ms);
	return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

// 把 [startMs, endMs] 的墙钟秒数按本地午夜切分：{ "YYYY-MM-DD": 秒 }。
// 分段内先取整再累加，与 background.accountUsage 完全一致（一致性测试锁定）。
function splitUsageByDay(startMs, endMs) {
	const out = {};
	if (!(endMs > startMs)) {
		return out;
	}
	let cursor = startMs;
	while (cursor < endMs) {
		const key = dayKey(cursor);
		const d = new Date(cursor);
		const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
		const segEnd = Math.min(endMs, nextMidnight);
		const secs = Math.round((segEnd - cursor) / 1000);
		if (secs > 0) {
			out[key] = (out[key] || 0) + secs;
		}
		cursor = segEnd;
	}
	return out;
}

// 历史记录的结束时刻：用户结束时是 endTime；到时归档的是 settledAt。
function sessionEndMs(s) {
	return s.endTime || s.settledAt || s.plannedEndTime || s.startTime || 0;
}

// 日报：某一天的网站 / 用途 / 计划 vs 实际 / 次数。只从 History 计算。
function buildDailyReport(sessions, day) {
	const sites = {};
	const purposes = {};
	let plannedSecs = 0;
	let actualSecs = 0;
	let sessionCount = 0;
	let extensionCount = 0;
	let extendedSessions = 0;
	const seen = {};

	const list = Array.isArray(sessions) ? sessions : [];
	for (const s of list) {
		if (!s || !s.id || seen[s.id]) {
			continue; // 一个 Session 只计一次（防御性去重）
		}
		seen[s.id] = true;

		const startDay = dayKey(s.startTime || 0);
		if (startDay === day) {
			// 次数与计划时间归属开始日
			sessionCount += 1;
			extensionCount += (s.extensionCount || 0);
			if ((s.extensionCount || 0) > 0) {
				extendedSessions += 1;
			}
			plannedSecs += (s.plannedSeconds || 0);
		}

		// 实际时间按午夜切分归日；网站 / 用途的当日秒数同步切分
		const split = splitUsageByDay(s.startTime || 0, sessionEndMs(s));
		const daySecs = split[day] || 0;
		if (daySecs > 0) {
			actualSecs += daySecs;
			const site = s.site || s.domain || "未知";
			sites[site] = (sites[site] || 0) + daySecs;
			const purpose = s.purpose || "其他";
			purposes[purpose] = (purposes[purpose] || 0) + daySecs;
		}
	}

	const toPairs = (obj) => Object.entries(obj)
			.map(([name, secs]) => ({ name: name, seconds: secs }))
			.sort((a, b) => b.seconds - a.seconds);

	return {
		day: day,
		sites: toPairs(sites),
		purposes: toPairs(purposes),
		plannedSecs: plannedSecs,
		actualSecs: actualSecs,
		sessionCount: sessionCount,
		extensionCount: extensionCount,
		extendedSessions: extendedSessions
	};
}

// 基础概览：今天 + 最近 7 天 + 平均值。描述行为，不评价用户（§11）。
function buildOverview(sessions, nowMs) {
	const today = dayKey(nowMs);
	const weekStart = new Date(nowMs); weekStart.setHours(0, 0, 0, 0);
	weekStart.setDate(weekStart.getDate() - 6); // 含今天的最近 7 个自然日
	const weekStartMs = weekStart.getTime();

	const report = buildDailyReport(sessions, today);
	let actual7 = 0;
	let sessionCount7 = 0;
	let extensionCount7 = 0;
	let plannedSecs7 = 0;
	let actualTotal7 = 0;
	const seen = {};

	const list = Array.isArray(sessions) ? sessions : [];
	for (const s of list) {
		if (!s || !s.id || seen[s.id]) {
			continue;
		}
		seen[s.id] = true;
		const startDay = dayKey(s.startTime || 0);
		const inWeek = (s.startTime || 0) >= weekStartMs;
		if (inWeek) {
			sessionCount7 += 1;
			extensionCount7 += (s.extensionCount || 0);
			plannedSecs7 += (s.plannedSeconds || 0);
		}
		const split = splitUsageByDay(s.startTime || 0, sessionEndMs(s));
		for (const [key, secs] of Object.entries(split)) {
			if (key >= dayKey(weekStartMs) && key <= today) {
				actual7 += secs;
			}
		}
		if (inWeek) {
			actualTotal7 += (s.actualSeconds || 0);
		}
	}

	return {
		today: {
			actualSecs: report.actualSecs,
			sessionCount: report.sessionCount,
			extensionCount: report.extensionCount
		},
		last7: {
			actualSecs: actual7,
			sessionCount: sessionCount7,
			extensionCount: extensionCount7,
			extendedSessions: list.filter((s) => s && (s.startTime || 0) >= weekStartMs
					&& (s.extensionCount || 0) > 0).length,
			directEnds: list.filter((s) => s && (s.startTime || 0) >= weekStartMs
					&& !(s.extensionCount > 0)).length,
			avgPlannedSecs: sessionCount7 ? Math.round(plannedSecs7 / sessionCount7) : 0,
			avgActualSecs: sessionCount7 ? Math.round(actualTotal7 / sessionCount7) : 0
		}
	};
}

// ---------- 导出（纯字符串构造，浏览器本地下载） ----------

function historyToJSON(sessions, exportedAt) {
	const list = Array.isArray(sessions) ? sessions : [];
	return {
		kind: "whytime-history",
		version: 1,
		exportedAt: exportedAt || new Date().toISOString(),
		sessions: list.map(function (s) {
			const out = {};
			for (const k in s) {
				out[k] = s[k];
			}
			out.startISO = s.startTime ? new Date(s.startTime).toISOString() : null;
			out.endISO = (s.endTime || s.settledAt)
					? new Date(s.endTime || s.settledAt).toISOString() : null;
			return out;
		})
	};
}

function csvField(v) {
	const s = (v == null) ? "" : String(v);
	return '"' + s.replace(/"/g, '""') + '"';
}

function historyToCSV(sessions) {
	const cols = ["id", "site", "start", "end", "plannedMinutes", "actualMinutes",
			"plannedSeconds", "actualSeconds", "purpose", "reason",
			"extensionCount", "endKind", "status", "breaks",
			"checkIns", "inconsistent", "deviations",
			"reviewDeviated", "reviewReason"];
	const fmtLocal = (ms) => {
		if (!ms) {
			return "";
		}
		const d = new Date(ms);
		return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
				+ " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
	};
	const lines = [cols.join(",")];
	const list = Array.isArray(sessions) ? sessions : [];
	for (const s of list) {
		if (!s) {
			continue;
		}
		// 目的对齐检查与偏离回顾（v0.10）：checkIns 是历次作答，deviations 是
		// "不一致但写理由继续"的原因合集，review 是到期后的整段回顾
		const checkIns = Array.isArray(s.checkIns) ? s.checkIns : [];
		const inconsistent = checkIns.filter((c) => c && c.consistent === false);
		const deviations = inconsistent
				.filter((c) => c.action === "continue" && c.reason)
				.map((c) => c.reason)
				.join(" | ");
		const row = {
			id: s.id,
			site: s.site || s.domain,
			start: fmtLocal(s.startTime),
			end: fmtLocal(s.endTime || s.settledAt),
			plannedMinutes: Math.round((s.plannedSeconds || 0) / 60),
			actualMinutes: Math.round((s.actualSeconds || 0) / 60),
			plannedSeconds: s.plannedSeconds || 0,
			actualSeconds: s.actualSeconds || 0,
			purpose: s.purpose,
			reason: s.reason,
			nextAction: s.nextAction || "",
			extensionCount: (typeof s.extensionCount === "number") ? s.extensionCount : 0,
			endKind: s.endKind,
			status: s.status,
			breaks: Array.isArray(s.breaks) ? s.breaks.length : 0,
			checkIns: checkIns.length,
			inconsistent: inconsistent.length,
			deviations: deviations,
			reviewDeviated: s.deviationReview ? (s.deviationReview.deviated ? "是" : "否") : "",
			reviewReason: (s.deviationReview && s.deviationReview.reason) || ""
		};
		lines.push(cols.map((c) => csvField(row[c])).join(","));
	}
	// UTF-8 BOM：保证 Excel 直接打开中文不乱码
	return "\uFEFF" + lines.join("\r\n");
}
