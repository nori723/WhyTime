/* WhyTime content script (Phase 1.4: thin).
 *
 * Injection and message round-trip patterns derive from LeechBlock NG
 * (MPL-2.0). Since Phase 1.4 the REAL blocking layer is blocked.html:
 * this script no longer locks pages with overlays. Its whole job is:
 *
 *   1. On page load, ask the background for a verdict.
 *      - "block": the background navigates this tab to blocked.html
 *        (chrome.tabs.update); we just stop loading the current page.
 *      - "allow" + active session: show the small countdown pill.
 *   2. When the local deadline check hits, tell the background — it
 *      settles the session and takes the tab away.
 *   3. On the expiry broadcast, ask to be taken to blocked.html too
 *      (the background re-validates the site and navigates).
 *
 * The countdown is computed from plannedEndTime - Date.now() every
 * second; setInterval here is display-only, never the authority.
 */

const browser = chrome;

var gSession = null;   // active session projected onto this page (may be null)
var gHost = null;
var gRoot = null;
var gTicker = null;    // 1s interval for pill display & local expiry check
var gNavigating = false;
var gIsFs = false;     // 宿主当前是否被 portal 进全屏元素
var gBreakPending = false; // 久坐休息触发中（防重复上报）
var gPillPos = null;   // 用户拖动后的计时条位置（非全屏，{left, top}，全局持久）

// ---------- small utilities ----------

function hostName(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch (error) {
		return "";
	}
}

function pad2(n) {
	return ((n < 10) ? "0" : "") + n;
}

function escapeHTML(text) {
	return String(text == null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtRemain(ms) {
	const s = Math.max(0, Math.ceil(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const ss = s % 60;
	return (h > 0) ? (h + ":" + pad2(m) + ":" + pad2(ss)) : (m + ":" + pad2(ss));
}

function send(message) {
	return browser.runtime.sendMessage(message).catch(function (error) {
		console.warn("[WhyTime] sendMessage failed:", error);
		return null;
	});
}

function leaveToBlocked() {
	// 后台已经在用 tabs.update 带这个 tab 去 blocked.html；
	// 停掉当前页面的加载与脚本，让跳转尽快接管。
	if (gNavigating) {
		return;
	}
	gNavigating = true;
	stopTicker();
	try {
		window.stop();
	} catch (error) {}
}

// ---------- fullscreen portal（仅服务于计时浮层的可见性） ----------

// While a fullscreen element exists, everything else paints underneath
// it (top layer). Move our host into the fullscreen subtree so the
// countdown stays visible over fullscreen video; move back on exit.
function syncFullscreenHost() {
	if (!gHost) {
		return;
	}
	const home = document.body || document.documentElement;
	if (!home) {
		return;
	}
	const fsEl = document.fullscreenElement
			|| document.webkitFullscreenElement || null;
	gIsFs = !!fsEl;
	if (gHost.classList) {
		gHost.classList.toggle("whytime-fs", gIsFs);
	}
	if (fsEl) {
		if (gHost.parentNode !== fsEl) {
			fsEl.appendChild(gHost);
		}
	} else if (gHost.parentNode !== home) {
		home.appendChild(gHost);
	}
}

document.addEventListener("fullscreenchange", syncFullscreenHost);
document.addEventListener("webkitfullscreenchange", syncFullscreenHost);

// ---------- countdown pill ----------

const STYLE = `
	:host {
		all: initial; /* 页面全局样式不得渗入宿主元素 */
		position: fixed; inset: 0; z-index: 2147483647;
		pointer-events: none;
	}
	* { box-sizing: border-box; margin: 0; padding: 0; }
	/* 顶部水平居中的红色状态提醒（静止，无动画）。
	   内容 = 使用目的（Session reason）+ 剩余时间；× = 主动结束本次使用。
	   位置：贴近视口顶端（top: 0），且全屏/非全屏共用同一偏移——全屏时
	   宿主在 top layer 铺满整屏（0 = 屏幕顶），非全屏时视口顶端之上是
	   浏览器自身工具栏（网页无法覆盖），贴顶即为两种模式下可达的一致位置。
	   剩余越少警示越强：t0 默认红 / t1 ≤5 分钟加深 / t2 ≤1 分钟最深 + 内描边 */
	.mini {
		position: absolute; top: 0; left: 50%; transform: translateX(-50%);
		pointer-events: auto;
		display: flex; align-items: center; gap: 10px;
		background: #b91c1c; color: #fff;
		border-radius: 999px; padding: 10px 12px 10px 18px;
		font: 600 15px/1.3 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
		font-variant-numeric: tabular-nums;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
		cursor: grab;
		user-select: none; -webkit-user-select: none;
		touch-action: none;
	}
	.mini.t1 { background: #991b1b; }
	.mini.t2 {
		background: #7f1d1d;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35), inset 0 0 0 2px rgba(255, 255, 255, 0.45);
	}
	.mini .dot {
		flex: none; width: 10px; height: 10px; border-radius: 50%;
		background: #fecaca;
		box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.18);
	}
	.mini.t2 .dot { background: #ffffff; }
	.mini .txt {
		max-width: 42vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.mini-end {
		appearance: none; border: 0; background: rgba(255, 255, 255, 0.2); color: #fff;
		width: 22px; height: 22px; border-radius: 50%; cursor: pointer;
		font-size: 13px; line-height: 1;
		flex: none;
	}
	/* 目的对齐检查弹窗：当前页轻量模态（不跳 blocked.html，不打断视频之外的浏览） */
	.check-backdrop {
		position: absolute; inset: 0; pointer-events: auto;
		display: none; align-items: center; justify-content: center;
		background: rgba(12, 16, 20, 0.45);
		font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
	}
	.check-backdrop.show { display: flex; }
	.check-card {
		width: min(420px, 92vw); max-height: 86vh; overflow: auto;
		background: #fff; color: #0c0a09; border: 1px solid #e2e8f0;
		border-radius: 18px; padding: 24px;
		box-shadow: 0 20px 60px rgba(15, 40, 30, 0.25);
	}
	.check-title { font-size: 15px; font-weight: 800; }
	.check-ctx {
		margin-top: 10px; padding: 10px 14px;
		background: #f6f8f7; border-radius: 12px;
		font-size: 13px; line-height: 1.7;
	}
	.check-q { margin-top: 12px; font-size: 14px; font-weight: 700; }
	.check-btns { display: flex; gap: 10px; margin-top: 16px; }
	.check-btn {
		flex: 1; appearance: none; border-radius: 12px; padding: 11px 14px;
		font: 600 14px inherit; font-family: inherit; cursor: pointer;
		border: 1px solid #e2e8f0; background: #fff; color: #0c0a09;
	}
	.check-btn.primary {
		border: 0; color: #fff;
		background: linear-gradient(135deg, #30d158, #0fa958);
		box-shadow: 0 8px 22px rgba(48, 209, 88, 0.3);
	}
	.check-btn.danger {
		border-color: rgba(255, 59, 48, 0.4); color: #ff3b30;
		background: rgba(255, 59, 48, 0.05);
	}
	.check-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.check-reason {
		width: 100%; min-height: 60px; margin-top: 4px; resize: vertical;
		border: 1px solid #e2e8f0; border-radius: 12px; padding: 10px;
		font: 14px/1.5 inherit; color: #0c0a09;
	}
	.check-err { margin-top: 10px; color: #ff3b30; font-size: 13px; }
	/* 非全屏可拖动（位置持久）；全屏时强制回到顶部居中，覆盖内联拖动样式 */
	:host(.whytime-fs) .mini {
		left: 50% !important; top: 0 !important;
		transform: translateX(-50%) !important;
	}
`;

function ensureRoot() {
	if (gHost && gHost.isConnected) {
		return gRoot;
	}
	gHost = document.createElement("div");
	gHost.id = "whytime-host";
	gRoot = gHost.attachShadow({ mode: "closed" });
	const style = document.createElement("style");
	style.textContent = STYLE;
	gRoot.appendChild(style);
	const mini = document.createElement("div");
	mini.id = "mini";
	mini.className = "mini t0";
	mini.title = "WhyTime · 使用中";
	mini.innerHTML = '<span class="dot"></span><span id="miniText" class="txt"></span>'
			+ '<button type="button" class="mini-end" id="miniEnd" title="结束本次使用">×</button>';
	gRoot.appendChild(mini);
	const endBtn = gRoot.getElementById("miniEnd");
	endBtn.addEventListener("click", function () {
		// × = 主动结束本次使用：交由 background 走统一归档路径（endSessionInternal），
		// 然后离开原网站进入 blocked.html Ended。不是隐藏计时器。
		endBtn.disabled = true;
		send({ type: "end-active", url: location.href }).then(function (res) {
			if (res && res.action === "block") {
				leaveToBlocked();
			} else {
				endBtn.disabled = false; // 竞态：Session 已被其他路径结算
			}
		});
	});
	enablePillDrag(mini);
	applyPillPos();
	const backdrop = document.createElement("div");
	backdrop.id = "checkBackdrop";
	backdrop.className = "check-backdrop";
	gRoot.appendChild(backdrop);
	(document.body || document.documentElement).appendChild(gHost);
	syncFullscreenHost();
	return gRoot;
}

// ---------- 计时条拖动（非全屏；位置全局持久） ----------

const PILL_POS_KEY = "whytime.pillPos";

// 夹取到当前视口内（宿主 fixed inset:0，绝对子元素坐标即视口坐标）
function clampPill(left, top) {
	const mini = gRoot && gRoot.getElementById("mini");
	if (!mini) {
		return null;
	}
	const vw = window.innerWidth, vh = window.innerHeight;
	const w = mini.offsetWidth, h = mini.offsetHeight;
	return {
		left: Math.min(Math.max(0, left), Math.max(0, vw - w)),
		top: Math.min(Math.max(0, top), Math.max(0, vh - h))
	};
}

// 应用持久化位置：改写内联 left/top 并去掉居中 transform
function applyPillPos() {
	const mini = gRoot && gRoot.getElementById("mini");
	if (!mini || !gPillPos) {
		return;
	}
	const p = clampPill(gPillPos.left, gPillPos.top);
	if (!p) {
		return;
	}
	mini.style.transform = "none";
	mini.style.left = p.left + "px";
	mini.style.top = p.top + "px";
}

function enablePillDrag(mini) {
	mini.title = "WhyTime · 使用中（可拖动位置，× 结束本次使用）";
	mini.addEventListener("pointerdown", function (e) {
		// 全屏恒居中（CSS 强制覆盖内联样式），不响应拖动；× 按钮保持点击语义
		if (gIsFs || (e.target && e.target.id === "miniEnd")) {
			return;
		}
		e.preventDefault();
		const rect = mini.getBoundingClientRect();
		const offX = e.clientX - rect.left;
		const offY = e.clientY - rect.top;
		let moved = false;
		try {
			mini.setPointerCapture(e.pointerId);
		} catch (error) {}
		mini.style.cursor = "grabbing";

		const onMove = function (ev) {
			moved = true;
			const p = clampPill(ev.clientX - offX, ev.clientY - offY);
			if (!p) {
				return;
			}
			mini.style.transform = "none";
			mini.style.left = p.left + "px";
			mini.style.top = p.top + "px";
		};
		const onUp = function () {
			mini.removeEventListener("pointermove", onMove);
			mini.removeEventListener("pointerup", onUp);
			mini.removeEventListener("pointercancel", onUp);
			mini.style.cursor = "grab";
			if (moved) {
				gPillPos = {
					left: parseFloat(mini.style.left) || 0,
					top: parseFloat(mini.style.top) || 0
				};
				browser.storage.local.set({ [PILL_POS_KEY]: gPillPos }).catch(function (error) {});
			}
		};
		mini.addEventListener("pointermove", onMove);
		mini.addEventListener("pointerup", onUp);
		mini.addEventListener("pointercancel", onUp);
	});
}

// 启动时读取持久化位置；窗口尺寸变化时重新夹取边界
browser.storage.local.get(PILL_POS_KEY).then(function (got) {
	const p = got[PILL_POS_KEY];
	if (p && typeof p.left === "number" && typeof p.top === "number") {
		gPillPos = p;
		applyPillPos();
	}
}).catch(function (error) {});
window.addEventListener("resize", applyPillPos);

function stopTicker() {
	if (gTicker) {
		clearInterval(gTicker);
		gTicker = null;
	}
}

function startTicker(session) {
	ensureRoot();
	stopTicker();
	const tick = function () {
		if (!gSession) {
			return;
		}
		const remain = gSession.plannedEndTime - Date.now();
		if (remain <= 0) {
			// Local deadline hit: the background settles the session and
			// takes this tab to blocked.html.
			send({ type: "expire-check", url: location.href }).then(function (res) {
				if (res && res.action === "block") {
					leaveToBlocked();
				}
			});
			return;
		}
		syncFullscreenHost();
		if (!gBreakPending
				&& (Date.now() - (gSession.breakMark || gSession.startTime)) >= 40 * 60000) {
			// 久坐：同一 Session 连续使用满 40 分钟，请后台带去拉伸页
			gBreakPending = true;
			send({ type: "stretch-break", url: location.href }).then(function (res) {
				if (res && res.action === "block") {
					leaveToBlocked();
				} else {
					gBreakPending = false;
				}
			});
			return;
		}
		const mini = gRoot && gRoot.getElementById("mini");
		if (mini) {
			// 分层警示：静止变色，不做持续动画
			mini.classList.remove("t0", "t1", "t2");
			mini.classList.add((remain <= 60000) ? "t2" : ((remain <= 300000) ? "t1" : "t0"));
			const el = gRoot.getElementById("miniText");
			if (el) {
				// 计时条内容 = 使用目的 + 剩余时间 + （若填写）之后要做的事
				const head = (gSession.reason || gSession.purpose || "使用中").trim();
				const tail = gSession.nextAction ? " · 之后: " + gSession.nextAction : "";
				el.textContent = head + " · 剩余 " + fmtRemain(remain) + tail;
			}
		}
	};
	gTicker = setInterval(tick, 1000);
	tick();
}

// ---------- boot ----------

// Ask for a verdict as early as possible (document_start). The
// background navigates blocked tabs itself; we only stop the page.
send({ type: "hello", url: location.href }).then(function (res) {
	if (!res) {
		return;
	}
	if (res.action === "block") {
		leaveToBlocked();
		return;
	}
	if (res.action === "allow" && res.session
			&& res.session.status === "active") {
		gSession = res.session;
		renderWhenReady(function () {
			startTicker(gSession);
		});
	}
});

function renderWhenReady(fn) {
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", fn, { once: true });
	} else {
		fn();
	}
}

// ---------- 目的对齐检查（每 10 分钟一次，当前页轻量模态） ----------

var gCheckOpen = false;

function dismissCheck() {
	gCheckOpen = false;
	const bd = gRoot && gRoot.getElementById("checkBackdrop");
	if (bd) {
		bd.classList.remove("show");
		bd.innerHTML = "";
	}
}

function showIntentionCheck(elapsedMin) {
	if (gCheckOpen || !gSession) {
		return;
	}
	ensureRoot();
	const bd = gRoot.getElementById("checkBackdrop");
	if (!bd) {
		return;
	}
	gCheckOpen = true;
	bd.innerHTML = '<div class="check-card">' +
			'<p class="check-title">目的对齐检查 · 已进行 ' + escapeHTML(elapsedMin) + ' 分钟</p>' +
			'<div class="check-ctx">目的：' + escapeHTML(gSession.purpose) + '<br>' +
			'原因：' + escapeHTML(gSession.reason) +
			(gSession.nextAction ? '<br>接下来：' + escapeHTML(gSession.nextAction) : '') + '</div>' +
			'<p class="check-q">你现在做的事情，和你的目的一致吗？</p>' +
			'<div class="check-btns">' +
			'<button type="button" class="check-btn primary" id="ckYes">一致</button>' +
			'<button type="button" class="check-btn" id="ckNo">不一致</button>' +
			'</div>' +
			'<div id="ckDetail" style="display:none">' +
			'<label style="display:block;margin:16px 0 8px;font-size:13px;font-weight:700">' +
			'偏离了什么？简单写一下原因</label>' +
			'<textarea class="check-reason" id="ckReason" maxlength="200" ' +
			'placeholder="例如：本来查资料，刷起了推荐视频"></textarea>' +
			'<div class="check-btns">' +
			'<button type="button" class="check-btn primary" id="ckContinue">写好了，继续使用</button>' +
			'<button type="button" class="check-btn danger" id="ckEnd">不用了，结束使用</button>' +
			'</div>' +
			'<p class="check-err" id="ckErr"></p>' +
			'</div>' +
			'</div>';
	bd.classList.add("show");

	gRoot.getElementById("ckYes").addEventListener("click", function () {
		send({ type: "intention-answer", url: location.href, consistent: true })
				.then(function (res) {
					if (res && res.action === "dismiss") {
						dismissCheck();
					}
				});
	});
	gRoot.getElementById("ckNo").addEventListener("click", function () {
		gRoot.getElementById("ckDetail").style.display = "block";
		gRoot.getElementById("ckReason").focus();
	});
	gRoot.getElementById("ckContinue").addEventListener("click", function () {
		const reason = gRoot.getElementById("ckReason").value.trim();
		if (!reason) {
			gRoot.getElementById("ckErr").textContent = "请写一下偏离的原因";
			return;
		}
		send({ type: "intention-answer", url: location.href, consistent: false,
				action: "continue", reason: reason }).then(function (res) {
			if (res && res.type === "error") {
				gRoot.getElementById("ckErr").textContent = res.message;
				return;
			}
			if (res && res.action === "dismiss") {
				dismissCheck();
			}
		});
	});
	gRoot.getElementById("ckEnd").addEventListener("click", function () {
		send({ type: "intention-answer", url: location.href, consistent: false,
				action: "end" }).then(function (res) {
			if (res && res.action === "block") {
				leaveToBlocked(); // 结束 = 离开原网站去 blocked.html Ended
			}
		});
	});
}

browser.runtime.onMessage.addListener(function (message) {
	// session-expired：到时结算；session-ended：其他 tab 的 × 提前结束。
	// 两者对本页含义相同——离开原网站，去 blocked.html（后台会重新校验站点）。
	if (message && message.type === "curfew-start") {
		// 宵禁到点：受限页一律请求带去睡觉页（SW 复核名单与窗口）
		send({ type: "curfew-check", url: location.href }).then(function (res) {
			if (res && res.action === "block") {
				leaveToBlocked();
			}
		});
		return;
	}
	if (message && message.type === "stretch-break" && gSession && !gBreakPending) {
		gBreakPending = true;
		send({ type: "stretch-break", url: location.href }).then(function (res) {
			if (res && res.action === "block") {
				leaveToBlocked();
			} else {
				gBreakPending = false;
			}
		});
		return;
	}
	if (message && message.type === "intention-check"
			&& gSession && gSession.status === "active") {
		showIntentionCheck(message.elapsedMin);
		return;
	}
	if (message && (message.type === "session-expired"
			|| message.type === "session-ended") && gSession) {
		dismissCheck();
		send({ type: "go-blocked", url: location.href }).then(function (res) {
			if (res && res.action === "block") {
				leaveToBlocked();
			}
		});
	}
});

// bfcache: drop the ticker when hidden, re-sync state on show.
window.addEventListener("pagehide", function () {
	stopTicker();
});

window.addEventListener("pageshow", function (event) {
	if (event.persisted) {
		send({ type: "hello", url: location.href }).then(function (res) {
			if (res && res.action === "block") {
				leaveToBlocked();
			} else if (res && res.action === "allow" && res.session
					&& res.session.status === "active") {
				gSession = res.session;
				startTicker(gSession);
			}
		});
	}
});
