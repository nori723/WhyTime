/* WhyTime options page (Phase 1: site list, extension limit, debug card).
 *
 * Storage schema and the cleanOptions/cleanSites sanitizing pattern
 * derive from LeechBlock NG (MPL-2.0). No jQuery; plain DOM. */

const browser = chrome;

const SETTINGS_KEY = "whytime.settings";
const ACTIVE_KEY = "whytime.activeSession";
const ARCHIVE_KEY = "whytime.sessions";

function getElement(id) {
	return document.getElementById(id);
}

async function loadSettings() {
	const got = await browser.storage.local.get([SETTINGS_KEY, ACTIVE_KEY, ARCHIVE_KEY]);
	const s = got[SETTINGS_KEY] || {};

	// 显示也走同一清洗层：textarea 里永远是规范化后的小写、每行一条
	getElement("sites").value =
			(typeof s.sites === "string") ? sanitizeSiteInput(s.sites).display : "";
	// 替代动作：缺失时显示默认（阅读 | 微信读书链接）
	getElement("altName").value =
			(typeof s.altName === "string") ? s.altName : "阅读|运动";
	getElement("altUrl").value =
			(typeof s.altUrl === "string") ? s.altUrl : "https://weread.qq.com/web|";
	getElement("curfewStart").value =
			(typeof s.curfewStart === "string" && s.curfewStart) ? s.curfewStart : "22:00";
	getElement("curfewEnd").value =
			(typeof s.curfewEnd === "string" && s.curfewEnd) ? s.curfewEnd : "06:00";
	getElement("maxExtensions").value =
			String(Number.isInteger(s.maxExtensions) ? s.maxExtensions : 0);

	renderSessionCard(got[ACTIVE_KEY], got[ARCHIVE_KEY]);
}

function renderSessionCard(active, archive) {
	const box = getElement("sessionBox");
	const count = Array.isArray(archive) ? archive.length : 0;
	if (active && active.status) {
		const s = active;
		box.textContent =
				"状态: " + s.status
				+ "\n网站: " + s.domain
				+ "\n目的: " + s.purpose + "    原因: " + s.reason
				+ "\n计划: " + Math.round(s.plannedSeconds / 60) + " 分钟（首次 "
					+ Math.round(s.initialPlannedSeconds / 60) + " 分钟）"
				+ "\n开始: " + new Date(s.startTime).toLocaleString()
				+ "\n到期: " + new Date(s.plannedEndTime).toLocaleString()
				+ "\n剩余: " + Math.max(0, Math.round((s.plannedEndTime - Date.now()) / 1000)) + " 秒"
				+ "\n续时: " + s.extensionCount + " 次"
				+ "\n\n[原始数据]\n" + JSON.stringify(s, null, 2)
				+ "\n\n历史已保存 Session: " + count + " 条";
	} else {
		box.textContent = "当前没有进行中的 Session。\n历史已保存 Session: " + count + " 条";
	}
}

async function saveSettings() {
	// WhyTime 清洗层（零宽字符/全角/前缀/去重）→ LeechBlock cleanSites 规范化
	const sanitized = sanitizeSiteInput(getElement("sites").value);
	const sites = cleanSites(sanitized.sites.join(" "), true);
	const maxExtensions = parseInt(getElement("maxExtensions").value, 10);

	await browser.storage.local.set({
		[SETTINGS_KEY]: {
			sites: sites,
			durations: [5, 10, 15, 20, 30, 45, 60],
			maxExtensions: Number.isInteger(maxExtensions) ? maxExtensions : 0,
			altName: getElement("altName").value.trim().slice(0, 60),
			altUrl: getElement("altUrl").value.trim().slice(0, 300),
			curfewStart: getElement("curfewStart").value || "22:00",
			curfewEnd: getElement("curfewEnd").value || "06:00"
		}
	});

	const tip = getElement("savedTip");
	tip.hidden = false;
	setTimeout(function () { tip.hidden = true; }, 2000);
	// "续时"节右上角也有一个保存按钮，反馈就地显示
	const tip2 = getElement("savedTip2");
	if (tip2) {
		tip2.hidden = false;
		setTimeout(function () { tip2.hidden = true; }, 2000);
	}
	const tip3 = getElement("savedTip3");
	if (tip3) {
		tip3.hidden = false;
		setTimeout(function () { tip3.hidden = true; }, 2000);
	}
	loadSettings();
}

getElement("save").addEventListener("click", saveSettings);
getElement("save2").addEventListener("click", saveSettings); // "续时"节右上角的保存按钮
	getElement("save3").addEventListener("click", saveSettings); // "睡觉锁定"节右上角的保存按钮
getElement("refreshSession").addEventListener("click", loadSettings);

window.addEventListener("DOMContentLoaded", loadSettings);
