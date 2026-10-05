/* WhyTime history / analytics page.
 *
 * Facts come from whytime.sessions (canonical Session History) via the
 * background, which sweeps stale sessions first. All aggregation runs
 * through wt-stats.js pure functions — the same code the automated
 * tests exercise. 描述行为，不评价用户：无评分、无排名、无价值判断。
 */

const browser = chrome;

var gSessions = [];
var gCap = 1000;

const SITE_NAMES = { // 仅展示层映射，数据主键始终是规范化 domain
	"bilibili.com": "B站",
	"youtube.com": "YouTube",
	"github.com": "GitHub",
	"zhihu.com": "知乎",
	"weibo.com": "微博",
	"xiaohongshu.com": "小红书"
};

function siteName(domain) {
	return SITE_NAMES[domain] || domain || "未知";
}

function pad2(n) {
	return ((n < 10) ? "0" : "") + n;
}

function mins(secs) {
	return Math.round(Math.max(0, secs || 0) / 60);
}

function fmtUsage(secs) {
	secs = Math.max(0, Math.round(secs || 0));
	return (secs < 60) ? "不足 1 分钟" : (Math.round(secs / 60) + " 分钟");
}

function fmtClock(ms) {
	if (!ms) {
		return "—";
	}
	const d = new Date(ms);
	return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function escapeHTML(text) {
	return String(text == null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function send(message) {
	return browser.runtime.sendMessage(message).catch(function (error) {
		console.warn("[WhyTime] sendMessage failed:", error);
		return null;
	});
}

function downloadFile(text, filename, mime) {
	const blob = new Blob([text], { type: mime });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.setAttribute("download", filename);
	a.dispatchEvent(new MouseEvent("click"));
}

// ---------- 渲染 ----------

function renderOverview() {
	const box = getElement("overview");
	const ov = buildOverview(gSessions, Date.now());
	const t = ov.today;
	const w = ov.last7;
	box.innerHTML = `
		<div class="ov-grid">
			<div class="ov-item"><div class="k">今天 · 实际使用</div><div class="v">${fmtUsage(t.actualSecs)}</div></div>
			<div class="ov-item"><div class="k">今天 · 打开次数</div><div class="v">${t.sessionCount}<small> 次</small></div></div>
			<div class="ov-item"><div class="k">今天 · 续时次数</div><div class="v">${t.extensionCount}<small> 次</small></div></div>
		</div>
		<p class="ov-line">
			最近 7 天：实际使用 ${fmtUsage(w.actualSecs)} · 打开 ${w.sessionCount7} 次 · 续时 ${w.extensionCount7} 次<br>
			平均每次计划 ${mins(w.avgPlannedSecs)} 分钟，实际 ${mins(w.avgActualSecs)} 分钟；
			其中 ${w.extendedSessions} 次发生过续时，${w.directEnds} 次未续时直接结束。
		</p>`;
}

function renderDaySelector() {
	const sel = getElement("daySelect");
	const days = [];
	const seen = {};
	for (const s of gSessions) {
		if (s && s.startTime) {
			const k = dayKey(s.startTime);
			if (!seen[k]) {
				seen[k] = true;
				days.push(k);
			}
		}
	}
	days.sort().reverse();
	const today = dayKey(Date.now());
	if (!seen[today]) {
		days.unshift(today);
	}
	sel.innerHTML = days.slice(0, 30).map((d) =>
			`<option value="${d}">${d}${d === today ? "（今天）" : ""}</option>`).join("");
	sel.onchange = renderDailyReport;
	renderDailyReport();
}

function renderDailyReport() {
	const box = getElement("dailyReport");
	const day = getElement("daySelect").value;
	const rep = buildDailyReport(gSessions, day);

	if (!rep.sessionCount && !rep.actualSecs) {
		box.innerHTML = `<p class="hs-empty">这一天没有使用记录。</p>`;
		return;
	}

	const siteRows = rep.sites.map((r) =>
			`<tr><td>${escapeHTML(siteName(r.name))}</td><td class="num">${fmtUsage(r.seconds)}</td></tr>`).join("");
	const purposeRows = rep.purposes.map((r) =>
			`<tr><td>${escapeHTML(r.name)}</td><td class="num">${fmtUsage(r.seconds)}</td></tr>`).join("");
	const delta = rep.actualSecs - rep.plannedSecs;
	const deltaText = (delta >= 0 ? "+" : "−") + fmtUsage(Math.abs(delta)).replace("分钟", "分钟").trim();

	box.innerHTML = `
		<p class="hs-subhead">网站使用</p>
		<table class="hs-table"><thead><tr><th>网站</th><th class="num">实际使用</th></tr></thead>
		<tbody>${siteRows}</tbody></table>
		<p class="hs-subhead">用途</p>
		<table class="hs-table"><thead><tr><th>用途</th><th class="num">实际使用</th></tr></thead>
		<tbody>${purposeRows}</tbody></table>
		<p class="hs-subhead">计划 vs 实际</p>
		<div class="hs-planvs">
			<div class="pv"><div class="k">计划</div><div class="v">${fmtUsage(rep.plannedSecs)}</div></div>
			<div class="pv"><div class="k">实际</div><div class="v">${fmtUsage(rep.actualSecs)}</div></div>
			<div class="pv"><div class="k">超出</div><div class="v ${delta > 0 ? "hs-delta-over" : ""}">${deltaText}</div></div>
		</div>
		<p class="hs-hint">这一天打开 ${rep.sessionCount} 次 · 续时 ${rep.extensionCount} 次 · ${rep.extendedSessions} 次发生过续时。</p>`;
}

function renderRecords() {
	const box = getElement("recordList");
	if (!gSessions.length) {
		box.innerHTML = `<p class="hs-empty">还没有使用记录。完成第一次使用承诺后，这里会显示每一次的使用情况。</p>`;
		return;
	}
	const latest = gSessions.slice(-100).reverse(); // 最近 100 条
	const rows = latest.map((s) => `
		<tr>
			<td>${fmtClock(s.startTime)}</td>
			<td>${escapeHTML(siteName(s.site || s.domain))}</td>
			<td>${escapeHTML(s.purpose || "其他")}</td>
			<td class="num">${mins(s.plannedSeconds)}m</td>
			<td class="num">${mins(s.actualSeconds)}m</td>
			<td class="num">${(typeof s.extensionCount === "number") ? s.extensionCount : 0}</td>
			<td class="reason-cell" title="${escapeHTML(s.reason)}">${escapeHTML(s.reason)}</td>
		</tr>`).join("");
	box.innerHTML = `
		<div class="hs-scroll">
		<table class="hs-table">
			<thead><tr><th>时间</th><th>网站</th><th>用途</th><th class="num">计划</th><th class="num">实际</th><th class="num">续时</th><th>原因</th></tr></thead>
			<tbody>${rows}</tbody>
		</table>
		</div>
		<p class="hs-hint">显示最近 ${latest.length} 条（共 ${gSessions.length} 条）。</p>`;
}

// ---------- 导出与清空 ----------

function todayStamp() {
	const d = new Date();
	return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function exportJSON() {
	const data = historyToJSON(gSessions, new Date().toISOString());
	downloadFile(JSON.stringify(data, null, 2),
			"whytime-history-" + todayStamp() + ".json", "application/json");
}

function exportCSV() {
	downloadFile(historyToCSV(gSessions),
			"whytime-history-" + todayStamp() + ".csv", "text/csv");
}

function setupClear() {
	const btn = getElement("clearBtn");
	let armed = false;
	let timer = null;
	btn.addEventListener("click", async function () {
		if (!armed) {
			armed = true;
			btn.textContent = "确认清空？不可恢复";
			btn.classList.add("confirm");
			timer = setTimeout(function () {
				armed = false;
				btn.textContent = "清空使用记录";
				btn.classList.remove("confirm");
			}, 5000);
			return;
		}
		clearTimeout(timer);
		armed = false;
		btn.textContent = "清空使用记录";
		btn.classList.remove("confirm");
		const res = await send({ type: "history-clear" });
		if (res && res.ok) {
			getElement("clearHint").textContent = "已清空。进行中的使用不受影响。";
			await load();
		}
	});
}

// ---------- boot ----------

function getElement(id) {
	return document.getElementById(id);
}

async function load() {
	const res = await send({ type: "history-get" });
	if (!res) {
		getElement("overview").textContent = "无法读取数据（后台不可用），请刷新重试。";
		return;
	}
	gSessions = Array.isArray(res.sessions) ? res.sessions : [];
	gCap = res.cap || 1000;
	getElement("capNotice").hidden = false; // 上限提示常驻（决策 #3）
	renderOverview();
	renderDaySelector();
	renderRecords();
}

getElement("exportJson").addEventListener("click", exportJSON);
getElement("exportCsv").addEventListener("click", exportCSV);
setupClear();

load();
