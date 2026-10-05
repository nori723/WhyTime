/* WhyTime blocked page script.
 *
 * Communication pattern reused from LeechBlock NG's blocked.js (MPL-2.0):
 * the page announces itself and requests its render context from the
 * background via a runtime message. Everything rendered here is new
 * WhyTime UI.
 *
 * Security model: this page only ever holds an opaque ctx token in its
 * URL. The trusted returnUrl lives in background storage and is redeemed
 * through "block-context"; navigation back to the site happens with the
 * URL the background handed us, never with anything from query params.
 * The VIEW and all time figures are derived from live session state by
 * the background — this page is a pure presentation layer (§13).
 */

const browser = chrome;

const PURPOSES = ["工作", "学习", "信息查询", "社交", "娱乐", "放松", "其他"];
const EXTEND_CHOICES = [5, 10, 20]; // promise form quick picks, default 5
const MIN_MINUTES = 1;
const MAX_MINUTES = 240;
const CONTINUE_SUCCESS_MILLIS = 2500; // 续时成功页停留时长（§12）

var gCtxId = "";
var gReturnUrl = null;
var gDurations = [5, 10, 20, 30, 45, 60];
var gReturnTimer = null;

function getElement(id) {
	return document.getElementById(id);
}

function pad2(n) {
	return ((n < 10) ? "0" : "") + n;
}

function fmtClock(ms) {
	const d = new Date(ms);
	return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

// 当日累计的展示口径：不足 1 分钟如实说"不足 1 分钟"
function fmtUsage(secs) {
	secs = Math.max(0, Math.round(secs || 0));
	return (secs < 60) ? "不足 1 分钟" : (Math.round(secs / 60) + " 分钟");
}

function mins(secs) {
	return Math.round((secs || 0) / 60);
}

// 剪贴板写入：优先 Clipboard API，失败回退 execCommand（扩展页 + 用户点击手势下均可用）
function fallbackCopy(text) {
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.style.position = "fixed";
	ta.style.opacity = "0";
	document.body.appendChild(ta);
	ta.select();
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch (error) {
		ok = false;
	}
	document.body.removeChild(ta);
	return ok;
}

function copyText(text) {
	if (navigator.clipboard && navigator.clipboard.writeText) {
		return navigator.clipboard.writeText(text)
				.then(function () { return true; })
				.catch(function () { return fallbackCopy(text); });
	}
	return Promise.resolve(fallbackCopy(text));
}

function escapeHTML(text) {
	return String(text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function send(message) {
	return browser.runtime.sendMessage(message).catch(function (error) {
		console.warn("[WhyTime] sendMessage failed:", error);
		return null;
	});
}

function showToday(todaySeconds) {
	const el = getElement("todayUsage");
	if (!el) {
		return;
	}
	el.textContent = "今天已使用 " + fmtUsage(todaySeconds);
	el.hidden = false;
}

// ---------- view templates ----------

function gateHTML(gateInfo) {
	const gi = gateInfo || null;
	const countLine = (gi && gi.todayCount > 0)
			? `<p class="gate-count">这是今天第 ${gi.todayCount} 次使用 · 该站已累计 ${Math.round(gi.todaySiteSecs / 60)} 分钟</p>`
			: "";
	const cooling = (gi && gi.cooldownUntil > Date.now());
	const cooldownLine = cooling
			? `<p class="cooldown-line" id="cooldownLine">冷静期：还需 <b id="cooldownSecs">--</b> 才能开始新的使用——先离开一会儿。</p>`
			: "";
	return `
	<div class="state-head">
		<h1>先想清楚，再打开</h1>
		<p class="state-sub">给这次使用一个明确的目的。</p>
	</div>
	${countLine}
	${cooldownLine}
	<label>使用目的</label>
	<div class="chips" id="purposeChips">
		${PURPOSES.map((p) => `<button type="button" class="chip" data-value="${p}">${p}</button>`).join("")}
	</div>
	<div class="label-row">
		<label>具体要做什么？</label>
		<button type="button" id="copyReasonBtn" class="copy-btn" disabled>复制</button>
	</div>
	<textarea id="reasonInput" maxlength="200" placeholder="例如：看教程"></textarea>
	<label>做完这件事，接下来去？</label>
	<p class="gate-nudge">写明下一步，做完就去做——空档才是"再刷一会儿"的入口。</p>
	<textarea id="nextAction" maxlength="60" placeholder="例如：去阅读"></textarea>
	<div class="tomorrow-box">
		<p class="tomorrow-q">换位想一想：如果是<b>明天的你</b>，还会做这个决定吗？</p>
		<div class="chips" id="tomorrowChips">
			<button type="button" class="chip" data-value="yes">会</button>
			<button type="button" class="chip" data-value="no">不会</button>
		</div>
	</div>
	<div class="label-row">
		<label>预计使用多久？</label>
		<span class="end-hint" id="endHint"></span>
	</div>
	<p class="gate-nudge">拿不准就选短的——到期可以再续；多出来的时间容易让人跑偏。</p>
	<div class="chips chips-grid" id="durationChips">
		${gDurations.map((d) => `<button type="button" class="chip" data-value="${d}">${d} 分钟</button>`).join("")}
	</div>
	<div class="custom-duration">
		<span class="unit">自定义</span>
		<input type="number" class="num" id="customMinutes" min="${MIN_MINUTES}" max="${MAX_MINUTES}" step="1" placeholder="1–${MAX_MINUTES}">
		<span class="unit">分钟（${MIN_MINUTES}–${MAX_MINUTES}）</span>
	</div>
	<button type="button" id="startBtn" class="btn-primary" disabled>开始使用</button>
	<p class="error-line" id="errLine"></p>`;
}

// 到期后的偏离回顾（用户要求：时间用完后问"期间是否偏离目的看了别的内容"）
function reviewHTML(session) {
	if (session.deviationReview) {
		const r = session.deviationReview;
		return `
		<div class="review-box">
			<h2>偏离回顾</h2>
			<p class="fact" style="border-bottom:0">已记录：${r.deviated ? "有偏离" : "没有偏离"}${r.reason ? " · " + escapeHTML(r.reason) : ""}</p>
		</div>`;
	}
	return `
	<div class="review-box" id="reviewBox">
		<h2>回顾一下</h2>
		<p class="fact" style="border-bottom:0">期间有没有偏离目的，去看别的内容？</p>
		<div class="btn-row" id="reviewBtns">
			<button type="button" class="btn-secondary" id="reviewNoBtn">没有偏离</button>
			<button type="button" class="btn-secondary" id="reviewYesBtn">有偏离</button>
		</div>
		<div id="reviewDetail" class="hidden">
			<label>偏离去看了什么？为什么？</label>
			<textarea id="reviewReason" maxlength="200" placeholder="例如：本来查资料，刷起了推荐视频"></textarea>
			<button type="button" id="reviewSubmit" class="btn-primary">提交回顾</button>
			<p class="error-line" id="reviewErr"></p>
		</div>
	</div>`;
}

function expiredHTML(session, maxExtensions, alt, todayExtCount) {
	const canExtend = (session.extensionCount < maxExtensions);
	// 继续次数一律来自后台的 session.extensionCount（§5），不做第二套计数
	const count = (typeof session.extensionCount === "number") ? session.extensionCount : 0;
	const extLine = (typeof todayExtCount === "number" && todayExtCount > 0)
			? `<p class="ext-count-line">今天这是第 ${todayExtCount} 次延长。</p>`
			: "";
	return `
	<div class="state-head">
		<h1>本次使用时间到了</h1>
	</div>
	${extLine}
	<div class="facts">
		<div class="fact"><span class="k">本次计划</span><span class="v">${mins(session.initialPlannedSeconds)} 分钟</span></div>
		<div class="fact"><span class="k">本次已使用</span><span class="v">${mins(session.actualSeconds)} 分钟</span></div>
		<div class="fact"><span class="k">继续次数</span><span class="v">${count} / ${maxExtensions}</span></div>
	</div>
	<p class="fact" style="border-bottom:0">原因：${escapeHTML(session.reason)}</p>
	${session.nextAction ? `<p class="next-action-line">你之前说过，做完就去：<b>${escapeHTML(session.nextAction)}</b>——现在正是时候。</p>` : ""}
	${reviewHTML(session)}
	${canExtend ? `
	<p class="state-sub">如果还需要继续，请说明新的理由。</p>
	<div class="btn-row">
		<button type="button" class="btn-secondary" id="showPromiseBtn">继续使用</button>
		<button type="button" class="btn-secondary btn-danger" id="endBtn">结束使用</button>
	</div>
	<div class="promise-box hidden" id="promiseBox">
		<h2>为什么还需要继续？</h2>
		${altInlineHTML(pickAlt(alt))}
		${Array.isArray(session.extensions) && session.extensions.length
			? `<p class="prev-reasons">前几次的理由：${session.extensions.map((e) => escapeHTML(e.reason)).join(" / ")}</p>`
			: ""}
		<div class="tomorrow-box">
			<p class="tomorrow-q">换位想一想：如果是<b>明天的你</b>，还会同意这次继续吗？</p>
			<div class="chips" id="tomorrowChips">
				<button type="button" class="chip" data-value="yes">会</button>
				<button type="button" class="chip" data-value="no">不会</button>
			</div>
		</div>
		<label>继续原因</label>
		<textarea id="extReason" maxlength="200" placeholder="例如：刚才的视频还没看完 / 需要把这个资料查完"></textarea>
		<label>还需要继续多久？</label>
		<div class="chips" id="extDurationChips">
			${EXTEND_CHOICES.map((d) => `<button type="button" class="chip${d === EXTEND_CHOICES[0] ? " on" : ""}" data-value="${d}">+${d} 分钟</button>`).join("")}
		</div>
		<p class="end-hint" id="extEndHint"></p>
		<button type="button" id="confirmBtn" class="btn-primary">确认继续 ${EXTEND_CHOICES[0]} 分钟</button>
		<button type="button" id="cancelPromiseBtn" class="btn-secondary btn-block">取消</button>
		<p class="error-line" id="extErrLine"></p>
	</div>`
	: `
	${maxExtensions > 0 ? `<p class="limit-note" style="margin-top:14px;padding:10px 14px;background:#fef3c7;border-radius:10px;font-size:13px">续时已达上限（${maxExtensions} 次），本次使用到此结束。</p>` : ""}
	${altInlineHTML(pickAlt(alt))}
	<button type="button" id="endBtn" class="btn-primary btn-danger-solid">结束使用</button>`}`;
}

// 续时成功反馈（§12）：信息完整，短暂停留后自动返回原页面
function continueSuccessHTML(session) {
	const exts = session.extensions || [];
	const last = exts[exts.length - 1];
	const add = last ? last.addMinutes : 0;
	return `
	<div class="state-head">
		<h1>已继续 ${add} 分钟</h1>
	</div>
	<div class="facts">
		<div class="fact"><span class="k">本次已使用</span><span class="v">${mins(session.actualSeconds)} 分钟</span></div>
		<div class="fact"><span class="k">本次新增</span><span class="v">${add} 分钟</span></div>
		<div class="fact"><span class="k">预计结束</span><span class="v">${fmtClock(session.plannedEndTime)}</span></div>
	</div>
	<p class="success-note">马上回到页面，记得你为什么而来。</p>
	<button type="button" id="backNowBtn" class="btn-primary">立即返回</button>`;
}

// 提前结束时的"省下的时间"来自后台（Session 权威），Ended 视图只做展示
function endedHTML(encourage, savedMin, alt) {
	const altEntry = pickAlt(alt);
	return `
	<div class="state-head">
		<h1>本次使用已结束</h1>
		<p class="state-sub">如果还需要使用，请重新做一次使用承诺。</p>
	</div>
	${savedMin > 0 ? `<p class="saved-note">比计划提前了 <b>${savedMin} 分钟</b>收场——这就是你省下来的时间。</p>` : ""}
	<p class="encourage">你停下来了。这比继续难。</p>
	${altEntry ? `
	<div class="alt-box">
		<p class="alt-q">刷完了，要不要换个地方待一会儿？</p>
		${altEntry.url
			? `<a class="alt-link" href="${escapeHTML(altEntry.url)}" target="_blank" rel="noreferrer">${escapeHTML(altEntry.name)} →</a>`
			: `<span class="alt-link">${escapeHTML(altEntry.name)}</span>`}
	</div>` : ""}
	<button type="button" id="restartBtn" class="btn-primary">重新开始</button>`;
}

function activeHTML(session) {
	return `
	<div class="state-head">
		<h1>使用进行中</h1>
		<p class="state-sub">${escapeHTML(session.domain)} · 剩余 ${fmtClock(session.plannedEndTime - Date.now())}（预计 ${fmtClock(session.plannedEndTime)} 结束）</p>
	</div>
	<button type="button" id="backBtn" class="btn-primary">返回网站</button>`;
}

function invalidHTML() {
	return `
	<div class="state-head">
		<h1>没有对应的拦截记录</h1>
		<p class="state-sub">这个页面由 WhyTime 在拦截受限网站时打开。直接打开它是没有意义的——去访问受限网站，WhyTime 会带你来这里。</p>
	</div>`;
}

// ---------- wiring helpers ----------

function bindChips(containerId, onPick) {
	const chips = document.querySelectorAll("#" + containerId + " .chip");
	for (const el of chips) {
		el.addEventListener("click", function () {
			for (const c of chips) {
				c.classList.remove("on");
			}
			el.classList.add("on");
			onPick(+el.dataset.value);
		});
	}
}

function navigateBack() {
	if (gReturnTimer) {
		clearTimeout(gReturnTimer);
		gReturnTimer = null;
	}
	if (gReturnUrl && /^https?:/i.test(gReturnUrl)) {
		location.replace(gReturnUrl);
	}
}

// ---------- views ----------

var gCooldownTimer = null;

// 冷却期倒计时：期间禁用开始按钮；到点自动恢复（update 由 wireGate 闭包提供）
function wireGateCooldown(gateInfo) {
	const gi = gateInfo || null;
	if (!gi || !(gi.cooldownUntil > Date.now())) {
		return;
	}
	const startBtn = getElement("startBtn");
	const line = getElement("cooldownLine");
	const secsEl = getElement("cooldownSecs");
	startBtn.disabled = true;
	const tick = function () {
		const left = Math.ceil((gi.cooldownUntil - Date.now()) / 1000);
		if (left <= 0) {
			clearInterval(gCooldownTimer);
			gCooldownTimer = null;
			startBtn.disabled = false; // 冷却结束，恢复由表单完整度决定
			if (line) {
				line.innerHTML = "冷静期结束——想清楚这次还要不要开始。";
			}
			return;
		}
		startBtn.disabled = true;
		if (secsEl) {
			secsEl.textContent = left + " 秒";
		}
	};
	gCooldownTimer = setInterval(tick, 250);
	tick();
}

function renderGate(gateInfo) {
	if (gCooldownTimer) {
		clearInterval(gCooldownTimer);
		gCooldownTimer = null;
	}
	getElement("view").innerHTML = gateHTML(gateInfo);
	wireGateCooldown(gateInfo);
	const state = { purpose: null, duration: null, reason: "", nextAction: "", perspective: null };
	const startBtn = getElement("startBtn");
	const errLine = getElement("errLine");
	const endHint = getElement("endHint");
	const copyBtn = getElement("copyReasonBtn");

	const update = function () {
		startBtn.disabled = !(state.purpose && state.duration && state.reason.trim() && state.nextAction.trim() && state.perspective !== null);
		copyBtn.disabled = !state.reason.trim(); // 复制按钮：有原因才可点
		endHint.textContent = state.duration
				? ("预计 " + fmtClock(Date.now() + (state.duration * 60000)) + " 结束")
				: "";
	};
	for (const el of document.querySelectorAll("#purposeChips .chip")) {
		el.addEventListener("click", function () {
			for (const c of document.querySelectorAll("#purposeChips .chip")) {
				c.classList.remove("on");
			}
			el.classList.add("on");
			state.purpose = el.dataset.value;
			update();
		});
	}
	bindChips("durationChips", function (m) {
		state.duration = m;
		getElement("customMinutes").value = "";
		update();
	});
	getElement("customMinutes").addEventListener("input", function (e) {
		const v = parseInt(e.target.value, 10);
		if (Number.isInteger(v) && v >= MIN_MINUTES && v <= MAX_MINUTES) {
			state.duration = v;
			for (const c of document.querySelectorAll("#durationChips .chip")) {
				c.classList.remove("on");
			}
		} else {
			state.duration = null;
		}
		update();
	});
	getElement("reasonInput").addEventListener("input", function (e) {
		state.reason = e.target.value;
		update();
	});
 getElement("nextAction").addEventListener("input", function (e) {
		state.nextAction = e.target.value;
		update();
	});
	for (const el of document.querySelectorAll("#tomorrowChips .chip")) {
		el.addEventListener("click", function () {
			for (const c of document.querySelectorAll("#tomorrowChips .chip")) {
				c.classList.remove("on");
			}
			el.classList.add("on");
			state.perspective = (el.dataset.value === "yes");
			update();
		});
	}
	copyBtn.addEventListener("click", function () {
		const text = state.reason.trim();
		if (!text) {
			return;
		}
		copyText(text).then(function (ok) {
			if (!ok) {
				errLine.textContent = "复制失败，请手动选择文本复制";
				return;
			}
			copyBtn.textContent = "已复制 ✓";
			copyBtn.classList.add("done");
			copyBtn.disabled = true;
			setTimeout(function () {
				copyBtn.textContent = "复制";
				copyBtn.classList.remove("done");
				update(); // 恢复按钮可用态
			}, 1500);
		});
	});
	startBtn.addEventListener("click", async function () {
		startBtn.disabled = true;
		errLine.textContent = "";
		const res = await send({
			type: "start-session",
			ctxId: gCtxId,
			reason: state.reason.trim(),
			purpose: state.purpose,
			plannedMinutes: state.duration,
			nextAction: (getElement("nextAction").value || "").trim(),
			perspective: state.perspective === true
		});
		if (res && res.type === "session-started" && res.returnUrl) {
			gReturnUrl = res.returnUrl;
			navigateBack();
			return;
		}
		startBtn.disabled = false;
		errLine.textContent = (res && res.message) || "出错了，请重试";
	});
}

function renderExpired(session, maxExtensions, alt, todayExtCount) {
	getElement("view").innerHTML = expiredHTML(session, maxExtensions, alt, todayExtCount);
	// 偏离回顾必答（v0.16.1）：作答前"继续使用/结束使用"锁定——避免无反思直接续命/离场
	const reviewAnswered = !!session.deviationReview;
	const unlockActions = function () {
		for (const id of ["continueBtn", "endBtn"]) {
			const b = getElement(id);
			if (b) b.disabled = false;
		}
	};
	wireReview(session, unlockActions);
	if (!reviewAnswered) {
		for (const id of ["continueBtn", "endBtn"]) {
			const b = getElement(id);
			if (b) b.disabled = true;
		}
	}
	const endBtn = getElement("endBtn");

	const showPromiseBtn = getElement("showPromiseBtn");
	if (showPromiseBtn) {
		showPromiseBtn.addEventListener("click", function () {
			getElement("promiseBox").classList.remove("hidden");
			showPromiseBtn.disabled = true;
		});
		const cancelBtn = getElement("cancelPromiseBtn");
		cancelBtn.addEventListener("click", function () {
			getElement("promiseBox").classList.add("hidden");
			showPromiseBtn.disabled = false;
		});

		const state = { duration: EXTEND_CHOICES[0], reason: "", perspective: null };
		const confirmBtn = getElement("confirmBtn");
		const extErrLine = getElement("extErrLine");
		const extEndHint = getElement("extEndHint");
		// 续命要有缝：展开表单后确认按钮先冷却 15 秒（理由/视角可以同时输入）
		const COOLDOWN_SECS = 15;
		let cooldownLeft = COOLDOWN_SECS;
		confirmBtn.disabled = true;
		let cooldownTimer = setInterval(function () {
			cooldownLeft -= 1;
			if (cooldownLeft > 0) {
				confirmBtn.textContent = "再等 " + cooldownLeft + " 秒…";
				return;
			}
			clearInterval(cooldownTimer);
			cooldownTimer = null;
			update();
		}, 1000);
		const update = function () {
			confirmBtn.textContent = "确认继续 " + state.duration + " 分钟";
			confirmBtn.disabled = !state.reason.trim() || cooldownTimer !== null || state.perspective === null;
			extEndHint.textContent = "预计 " + fmtClock(Date.now() + (state.duration * 60000)) + " 结束";
		};
		for (const el of document.querySelectorAll("#tomorrowChips .chip")) {
			el.addEventListener("click", function () {
				for (const c of document.querySelectorAll("#tomorrowChips .chip")) {
					c.classList.remove("on");
				}
				el.classList.add("on");
				state.perspective = (el.dataset.value === "yes");
				update();
			});
		}
		bindChips("extDurationChips", function (m) {
			state.duration = m;
			update();
		});
		getElement("extReason").addEventListener("input", function (e) {
			state.reason = e.target.value;
			update();
		});
		confirmBtn.addEventListener("click", async function () {
			if (!state.reason.trim()) {
				return; // 继续原因必填
			}
			confirmBtn.disabled = true;
			extErrLine.textContent = "";
			const res = await send({
				type: "extend-session",
				ctxId: gCtxId,
				addMinutes: state.duration,
				reason: state.reason.trim(),
				perspective: state.perspective === true
			});
			if (res && (res.type === "session-extended" || res.type === "resume-active")
					&& res.returnUrl) {
				gReturnUrl = res.returnUrl;
				// 成功页只在 background 已持久化之后出现（响应即写入完成）
				renderContinueSuccess(res.session);
				return;
			}
			confirmBtn.disabled = false;
			extErrLine.textContent = (res && res.message) || "出错了，请重试";
		});
		update();
	}

	endBtn.addEventListener("click", async function () {
		endBtn.disabled = true;
		const res = await send({ type: "end-session", ctxId: gCtxId });
		if (res && res.type === "session-ended") {
			if (typeof res.todaySeconds === "number") {
				showToday(res.todaySeconds);
			}
			renderEnded(null,
					res.session ? mins(res.session.plannedSeconds - res.session.actualSeconds) : 0,
					res.gateInfo || null, res.altList || null);
		} else {
			endBtn.disabled = false;
		}
	});
}

// 偏离回顾：提交后落到 Session（随归档进 History/CSV），不强制作答
function wireReview(session, onAnswered) {
	const box = getElement("reviewBox");
	if (!box || session.deviationReview) {
		return;
	}
	const yesBtn = getElement("reviewYesBtn");
	const noBtn = getElement("reviewNoBtn");
	const finish = function () {
		box.innerHTML = '<p class="fact" style="border-bottom:0">已记录本次回顾 ✓</p>';
	};
	noBtn.addEventListener("click", async function () {
		noBtn.disabled = true;
		yesBtn.disabled = true;
		const res = await send({ type: "deviation-review", ctxId: gCtxId, deviated: false });
		if (res && res.ok) {
			finish();
			if (onAnswered) onAnswered();
		} else {
			noBtn.disabled = false;
			yesBtn.disabled = false;
		}
	});
	yesBtn.addEventListener("click", function () {
		getElement("reviewBtns").classList.add("hidden");
		getElement("reviewDetail").classList.remove("hidden");
	});
	const submitBtn = getElement("reviewSubmit");
	submitBtn.addEventListener("click", async function () {
		const reason = getElement("reviewReason").value.trim();
		const err = getElement("reviewErr");
		if (!reason) {
			err.textContent = "请写一下偏离的内容和原因";
			return;
		}
		submitBtn.disabled = true;
		const res = await send({
			type: "deviation-review", ctxId: gCtxId, deviated: true, reason: reason
		});
		if (res && res.ok) {
			finish();
			if (onAnswered) onAnswered();
		} else {
			submitBtn.disabled = false;
			err.textContent = (res && res.message) || "出错了，请重试";
		}
	});
}

function renderContinueSuccess(session) {
	getElement("view").innerHTML = continueSuccessHTML(session);
	getElement("backNowBtn").addEventListener("click", navigateBack);
	gReturnTimer = setTimeout(navigateBack, CONTINUE_SUCCESS_MILLIS);
}

function sleepHTML(info) {
	return `
	<div class="state-head">
		<h1>现在是睡觉时间</h1>
		<p class="state-sub">受限网站已全部锁定（${escapeHTML(info.curfewStart)} – ${escapeHTML(info.curfewEnd)}）。</p>
	</div>
	<p class="sleep-moon">🌙</p>
	<p class="fact" style="border-bottom:0">无论什么理由，现在都无法使用——明天再来吧，明天有的是时间。</p>`;
}

function breakHTML(session) {
	void session;
	return `
	<div class="state-head">
		<h1>该站起来活动了</h1>
		<p class="state-sub">已经连续坐了 40 分钟——休息不算在你的使用时间里。</p>
	</div>
	<p class="break-timer" id="breakTimer">--:--</p>
	<div class="stretch-list">
		<p>股四头肌拉伸：站立，手拉脚背向臀部，左右各 30 秒</p>
		<p>小腿拉伸：弓步推墙，后腿伸直脚跟踩地，左右各 30 秒</p>
		<p>顺便：接一杯水，看一眼 6 米以外的地方</p>
	</div>
	<button type="button" id="backBtn" class="btn-primary" disabled>活动完成，回去继续</button>
	<button type="button" id="breakEndBtn" class="btn-secondary btn-block">不想继续了，结束使用</button>`;
}

function pickAlt(altList) {
	const list = Array.isArray(altList) ? altList.filter((a) => a && a.name) : [];
	return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

// 替代动作入口（邀请语气）：有链接为 <a>，无链接只显示文字
function altInlineHTML(alt) {
	if (!alt) {
		return "";
	}
	const inner = alt.url
			? '<a class="alt-link" href="' + escapeHTML(alt.url) + '" target="_blank" rel="noreferrer">' + escapeHTML(alt.name) + ' →</a>'
			: '<span class="alt-link">' + escapeHTML(alt.name) + '</span>';
	return '<p class="alt-inline">或者，现在就离开，去' + inner + '</p>';
}

function renderSleep(info) {
	getElement("view").innerHTML = sleepHTML(info); // 无按钮：睡觉锁定没有任何出口
}

var gBreakTimer = null;

function renderBreak(session) {
	getElement("view").innerHTML = breakHTML(session, session.breakUntil);
	const timer = getElement("breakTimer");
	const backBtn = getElement("backBtn");
	const pad2t = (n) => ((n < 10) ? "0" : "") + n;
	if (gBreakTimer) {
		clearInterval(gBreakTimer);
		gBreakTimer = null;
	}
	const finish = function () {
		backBtn.disabled = false;
		timer.textContent = "00:00";
	};
	const tick = function () {
		const left = session.breakUntil - Date.now();
		if (left <= 0) {
			finish();
			return;
		}
		const s = Math.ceil(left / 1000);
		timer.textContent = pad2t(Math.floor(s / 60)) + ":" + pad2t(s % 60);
	};
	gBreakTimer = setInterval(tick, 250);
	tick();

	backBtn.addEventListener("click", async function () {
		backBtn.disabled = true;
		const res = await send({ type: "break-done", ctxId: gCtxId });
		if (res && res.type === "break-done" && res.returnUrl) {
			if (gBreakTimer) {
				clearInterval(gBreakTimer);
				gBreakTimer = null;
			}
			gReturnUrl = res.returnUrl;
			navigateBack();
		} else {
			backBtn.disabled = false;
		}
	});
	getElement("breakEndBtn").addEventListener("click", async function () {
		getElement("breakEndBtn").disabled = true;
		const res = await send({ type: "end-session", ctxId: gCtxId });
		if (res && res.type === "session-ended") {
			if (gBreakTimer) {
				clearInterval(gBreakTimer);
				gBreakTimer = null;
			}
			if (typeof res.todaySeconds === "number") {
				showToday(res.todaySeconds);
			}
			renderEnded(null, 0, res.gateInfo || null); // 留在 blocked.html
		} else {
			getElement("breakEndBtn").disabled = false;
		}
	});
}

function renderEnded(encourage, savedMin, gateInfo, alt) {
	getElement("view").innerHTML = endedHTML(encourage, savedMin, alt);
	getElement("restartBtn").addEventListener("click", function () {
		// 不复活旧 Session：重新走完整承诺 → 新 Session（可能需先过冷静期）
		renderGate(gateInfo || null);
	});
}

function renderActive(session) {
	getElement("view").innerHTML = activeHTML(session);
	getElement("backBtn").addEventListener("click", navigateBack);
}

function renderInvalid() {
	getElement("view").innerHTML = invalidHTML();
}

// ---------- boot ----------

gCtxId = new URLSearchParams(location.search).get("ctx") || "";

send({ type: "block-context", ctxId: gCtxId }).then(function (res) {
	if (!res) {
		renderInvalid();
		return;
	}
	if (Array.isArray(res.durations) && res.durations.length) {
		gDurations = res.durations;
	}
	if (typeof res.todaySeconds === "number") {
		showToday(res.todaySeconds);
	}
	if (res.returnUrl && /^https?:/i.test(res.returnUrl)) {
		gReturnUrl = res.returnUrl; // 只接受后台签发的 returnUrl
	}
	switch (res.view) {
		case "gate":
			renderGate(res.gateInfo);
			break;
		case "expired":
			renderExpired(res.session, res.maxExtensions, res.altList, res.todayExtCount);
			break;
		case "active":
			renderActive(res.session);
			break;
		case "break":
			renderBreak(res.session);
			break;
		case "sleep":
			renderSleep(res);
			break;
		case "ended":
			renderEnded(res.encourage, res.savedMin, res.gateInfo, res.altList);
			break;
		default:
			renderInvalid();
			break;
	}
});
