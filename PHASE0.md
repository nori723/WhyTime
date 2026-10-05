# 有因 WhyTime · Phase 0 源码调研报告

日期：2026-10-03
状态：Phase 0 完成（未修改两个源项目的任何文件）
目标：回答"哪个文件负责什么 + 哪些复用/修改/新写"，为 Phase 1 提供施工依据。

---

## 0. 结论先行

- **直接复用 LeechBlock**：站点匹配引擎（common.js 整文件）、content script 注入模式与计时器样式、manifest 骨架、扩展页通用工具。
- **改造复用**：background 事件骨架、"限时放行四元组"（allowBlockedPage）、"按周期计数限额"（applyOverride）——最后这个和"最多续时 2 次"同构。
- **从 Flow 吸收机制（不抄代码，GPLv3）**：activeSession 记账模型（时间戳差值 + capElapsed + 心跳兜底）、chrome.idle 防抖、四层存储分层、storage.session 存瞬态、主题 token 体系。
- **真正新写的只有 4 块**：①需求门 overlay（表单收集）②Session 生命周期与到期 overlay（含有限续时）③Session 历史与统计聚合（Phase 3）④Flow 风格设置页（Phase 4）。
- **架构红线**：门控与到期全部是 content script overlay + storage 里的 Session 状态，**不做 blocked.html 跳转**；到期判定 = `plannedEndTime - Date.now()` + chrome.alarms 兜底，不依赖 setTimeout，不用 offscreen ticker。

---

## 1. 项目基本盘

| | LeechBlock NG | Flow |
|---|---|---|
| 本地路径 | `Desktop\LeechBlockNG-chrome-master\` | `Desktop\Flow-main\Flow-main\`（zip 解压双层嵌套，真实根目录在内层） |
| 许可 | MPL-2.0（可复用，保留文件头） | GPLv3（只借鉴思路，不复制代码） |
| Manifest | MV3，v1.7.3 | MV3，v10.1.1.2 |
| 结构 | 扁平（根目录 22 个 js/html） | `src/` 分模块（background/blocked/content/dashboard/lib/popup/styles） |
| 依赖 | jQuery + jQuery UI（options/stats 等页面） | 零运行时依赖；图表全部手绘 canvas 2D |
| 构建 | 无构建，直接加载 | `tools/build.js`：esbuild 仅做 minify，产出 chrome/edge/firefox 三份 dist，自动改写 Firefox manifest |
| 桌面现状 | — | 桌面另有空的 `WhyTime\` 目录（本项目家目录） |

LBNG manifest 权限：`alarms, contextMenus, offscreen, storage, tabs, unlimitedStorage, webNavigation`（+可选 history）。Flow 权限：`storage, unlimitedStorage, alarms, idle, notifications, declarativeNetRequest, scripting, favicon` + `<all_urls>`。**WhyTime 需要的 `idle` 权限 Flow 有、LBNG 没有**（LBNG 无 idle 检测）。

---

## 2. LeechBlock 职责地图

| 职责 | 文件 : 行 | 机制 |
|---|---|---|
| **background** | `background.js`（2038 行，MV3 SW） | `importScripts("common.js")`；全部状态在内存 `gOptions`（选项平铺对象）+ `gTabs[]`（每 tab 状态：url/referrer/focused/loaded/allowedHost…）；首 tick 时 `retrieveOptions` 从 storage 重建 |
| **site matching** | `common.js` `getRegExpSites` L275、`patternToRegExp` L330、`cleanSites` L261、`getParsedURL` L218 | 空白分隔 pattern 列表 → 编译成 block/allow/refer/keyword 四个正则；`+` 例外允许、`>` 按 referrer、`~` 关键词、`*`/`**` 通配；`matchSubdomains` 控制 `([^/]*\.)?` vs `(www\.)?` |
| **blocking 决策** | `background.js` `checkTab` L449 | 汇总 lockdown(timedata[4])/minBlock(timedata[8])/时段(times+days)/限额(limitMins×limitPeriod+rollover)/override(oret) → `doBlock` |
| **blocking 动作** | `background.js` `applyBlock` L669 | 三选一：关 tab / CSS 滤镜（发消息给 content script）/ `tabs.update` 重定向到 `blocked.html?$S&$U` |
| **content script** | `content.js`（215 行）+ `content.css` | 上报 `loaded`/`referrer`/`focus`；`.leechblock-timer` 角标计时器（dblclick 隐藏、pagehide 清理）；`.leechblock-alert-container` 全屏提示容器；`applyFilter`（grayscale/blur/fade…作用于 documentElement） |
| **timer** | `ticker.html` + `ticker.js`（36 行，offscreen document） | `setInterval` 每秒发 `{type:"tick"}` → `handleTick` L1964 → `processTabs` L394（clockPageTime + checkTab + updateTimer）；另有 6 个错峰 1 分钟 alarms 做 SW 保活（L2028-2037） |
| **用时统计口径** | `clockPageTime` L844 + `updateTimeData` L898 | `Date.now()` 差值记账；openTime/focusTime 双轨；`countFocus`（只计聚焦时间）、`countAudio`（有声才计）、`ignoreJumpSecs` L977（防时钟跳变）→ 写 `timedata{set}[1]` 总计 / `[3]` 本期限 |
| **storage** | `retrieveOptions` L191、`saveTimeData` L301 | chrome.storage.local / sync 二选一（`sync` 开关）；选项平铺 key（`sites1`、`limitMins1`…）；timedata 每 `saveSecs` 秒脏检查落盘；无 IndexedDB |
| **options** | `options.html`(34.8KB) + `options.js`（1357 行） | jQuery UI tabs；schema 定义在 common.js `PER_SET_OPTIONS` L32 / `GENERAL_OPTIONS` L88（type/def/id）；`cleanOptions` L148 类型消毒；导出 txt/JSON/同步存储 L933-1080；密码/访问码访问控制 |
| **blocked page** | `blocked.html` + `blocked.js`（delayed/password 共用） | 页面加载即发 `{type:"blocked"}` 换回 `createBlockInfo` L1098（主题/解锁时间/密码/自定义消息）；delayed 倒计时在 `onCountdownTimer` L120——**失焦自动取消倒计时**（delayCancel） |
| **限时放行** | `allowBlockedPage` L1502 | delayed 页倒数完成后设置 tab 的 `allowedHost/allowedPath/allowedSet/allowedEndTime` 四元组 → 在 `checkTab` L484 里作为豁免条件，到期自动失效 |
| **有限次数放行** | `override.js` + `applyOverride` L1387 | override 结束时间戳 `oret` + 按周期计数限额 `orln`(次数)/`orlp`(周期)/`orlps`(周期起点)/`orlc`(已用次数)——**与"最多续时 N 次"同构** |
| 其他页面 | `popup.js`/`stats.js`/`lockdown.js`/`add-sites.js`/`diagnostics.js` | stats 页按 set 显示总用时/周均/日均 + 重置（jQuery） |
| 主题 | `themes/{default,light,dark,spruce}.css` + `setTheme` common.js L576 | `<link id="themeLink">` 换 href，整页换肤 |
| i18n | `_locales/`（含 zh） | `__MSG_*__` + `localePath` 本地化页面路径 |

**计时模型小结**：所有期限（allowedEndTime、oret、timedata[4]…）都是 epoch 秒时间戳，所以休眠/锁屏/SW 重启后一律用 `Date.now()` 重算——这正好满足本需求 §五。SW 重启恢复靠"下一个 tick 发现 `gGotOptions=false` → retrieveOptions"。

**对本项目的短板**：无 idle 检测、无 visibilitychange 处理（仅 window focus/blur）、无按域名的使用历史（只有每 set 聚合数）、每秒全 tab 扫描偏重。

---

## 3. Flow 职责地图（路径均相对 `Flow-main/Flow-main/src/`）

| 职责 | 文件 : 行 | 机制 |
|---|---|---|
| **active tab tracking** | `background/service-worker.js` `handleTabChange` L365-478 | 事件源：`tabs.onActivated` L1063、`tabs.onUpdated`（仅 `tab.active && changeInfo.url` 才触发）L1064-1150、`tabs.onRemoved` L1151、`windows.onFocusChanged`（WINDOW_ID_NONE = 失焦立即 flush 清 session）L1154-1179。活跃 session 对象 `activeSession = {domain, startTime, visitStartTime, accumulatedTime, tabId}` 存 **chrome.storage.session** L421-459 |
| 记账口径 | `capElapsed` L120 | 时间戳差值记账（非周期累积）；间隔超过 `maxGapSecs`（默认 300s，防休眠计入）直接记 0；跨午夜按天拆分落账 L238-286；1 分钟 `tracker_heartbeat` alarm 兜底 flush（防 SW 被杀丢数据）L2550-2557 |
| **idle detection** | 同文件 L1182-1253、L2431 | `chrome.idle.setDetectionInterval(30s 默认)`；`onStateChanged`：**若 content script 心跳距 now < 20s 则忽略 idle 事件**（防抖）；锁屏全额计入、idle 超过 idleTimeout+60s 判休眠计 0；有声播放（看视频）可继续计时 |
| **content script** | `content/site-tracker.js`（590 行） | 交互监听（mousemove/scroll/keydown/touchstart 仅更新 lastInteract）L320；**10 秒心跳**：仅 `visibilityState==="visible"` 且 30s 内有交互才发 `TRACKING_HEARTBEAT{domain, elapsed}`（elapsed 钳制 1-15s）L335-361；SW 端校验"域名匹配 activeSession 且 tabId 一致"才记账（多 tab 去重）L1731；`visibilitychange` 立即 flush/恢复 L41-52 |
| **IndexedDB** | `lib/db.js` | `FocusFlowDB` v21：`daily_logs`(keyPath day) / `monthly_rollups`(month) / `meta`(key) 三个 store；day 行 `{day, entry:{sites:{域名:秒}, timeline:[{start,dur,cat}], 分类秒}}`；读取侧 shape 消毒 L70-131；保留期（默认 365 天）到期月卷积在 SW `compressOldData` L479-606 |
| **数据分层** | `lib/storage.js` + SW L195 | **sync** = 设置/预置；**local** = 规则/主题/favicon；**session** = 瞬态运行时（activeSession、flush 队列、心跳时间戳，浏览器关闭即失效）；**IndexedDB** = 一切时间序列。Firefox 无 storage.session 时 polyfill 成 local（storage.js L32-34） |
| **analytics** | SW `STATS_GET_DAY/RANGE/WEEK/ROLLUPS` L2272-2322 | SW 只供原始 day 行，**聚合在前端做**（改分类规则后历史占比跟着重算，dashboard.js `recalculateRangeStats` L776）；仅 all-time 总量与 streak 在 SW 预聚合 |
| **dashboard** | `dashboard/`（js 7034 行 + html + css） | 4 个顶层 tab：analytics（overview/daily/topsites/trend 四子视图）/ focus（含 365 天热力图）/ sitemanager / settings；**图表全部手绘 canvas 2D，零图表库**（历史上用过 Chart.js 后移除）；HTML 为静态骨架 + JS 模板字符串注入（setSafeHTML 防 XSS） |
| **popup** | `popup/`（html 212 行 + js 1131 行） | PIN 键盘 → Today/All Time 双 tab → 当前站点卡（favicon+快捷开关）→ SVG 环形图（当日分类占比）→ 番茄钟卡 → 今日站点时长排行 |
| **theme** | `styles/global.css` L4-83 + `applyTheme` | `documentElement.classList.toggle("light")` + CSS 变量；默认 dark；中性背景 4 级 / 文字 4 级；5 个强调色各带"主色/12% 透明底/30% 透明边"三件套；`--card-radius:16px`；自托管 Manrope；等宽数字 tabular-nums；小号大写微标签 |
| **export/import** | SW `BACKUP_EXPORT/IMPORT` L1898-1934 | `{version, exportedAt, daily, rollups, local, settings}` JSON 下载 + 导入，同时存 IDB meta 作本地快照 |
| **blocked 页** | `blocked/` + SW L880-924 | 整页方案：DNR main_frame 302 到扩展页。**注意**：其 cooldown 门（进站前倒计时 + 继续访问）是 content script 全屏 overlay（site-tracker.js L410-586）——与 WhyTime 交互最接近的先例 |
| 构建 | `tools/build.js` | 复制+minify；Firefox 适配自动改 manifest（service_worker→background.scripts、加 gecko id、删 favicon）；构建期 i18n lint |

**Flow 架构骨架一句话**：SW 内存无常驻状态——多信号事件 + idle + 心跳共同维护 session storage 里的 activeSession（时间戳差值），切走/失焦/隐藏/idle 时过滤后串行 flush 进 IndexedDB；前端从消息拿原始数据自行聚合展示。

---

## 4. 复用判断（§二十二 四问逐一作答）

### 4.1 直接复用（照搬，保留 MPL-2.0 文件头）

| 模块 | 来源 | 为什么直接用 |
|---|---|---|
| URL 解析 + 站点匹配引擎 | common.js 整文件（`getParsedURL`/`cleanSites`/`getRegExpSites`/`patternToRegExp`/`check*Format`/`formatTime`/`hashCode32`/`setTheme`） | 成熟、无依赖、通配符/子域语义齐全——"需要理由的网站"名单匹配直接用它，LeechBlock 已有 ✓，无需新写 |
| content script 注入骨架 | manifest 的 `content_scripts`（`<all_urls>` + document_start + content.css）+ content.js 的 loaded/消息往返模式 | 注入时机、z-index 2147483647、pagehide 清理都是踩过坑的现成答案 |
| 迷你计时浮层 | content.css `.leechblock-timer` | 角标 fixed 定位、dblclick 隐藏——正是 §六"右上角小浮层"的底子，改文案为 `B站 · 18:32` |
| manifest 骨架 | LBNG manifest | MV3 + `alarms/storage/tabs/unlimitedStorage/webNavigation`；去掉 `offscreen`（我们不用 ticker）、`contextMenus`（可后加）；**加 `idle`**（§十一 需要，照 Flow 用法） |
| 扩展页工具 | `openExtensionPage`（background.js L1475，激活已有 tab 或新建）、主题 link 机制 | 通用小工具，原样搬 |
| 落盘纪律 | `saveTimeData` 脏检查 L301、`cleanOptions` 消毒 L148 | 防止高频写 storage 的现成模式 |

### 4.2 修改后复用（保留骨架，换驱动方式）

| 模块 | 改法 |
|---|---|
| background.js 事件骨架 | 保留：监听器集合（tabs.onCreated/onUpdated/onActivated/onRemoved、runtime.onMessage、commands）、`initTab`/gTabs、handleMessage 分发。**改**：去掉每秒 tick 全表扫描，改为"时间戳判定 + chrome.alarms 到点唤醒 + content script 心跳兜底"；`checkTab` 砍掉时段/限额/lockdown/override 分支，只留"匹配名单 → 查 activeSession → 决定弹门/放行/到期" |
| 限时放行 | `allowBlockedPage` L1502 的 host/path/set/endTime 四元组 → 升级为完整 Session 记录（加 reason/purpose/plannedSeconds/extensionCount/status），且从内存 `gTabs` 挪到 **chrome.storage.local**（SW 重启可恢复——LBNG 放内存是因为它有 tick 自愈，我们用持久化更稳） |
| 失焦暂停思路 | blocked.js `onCountdownTimer` L120 的 delayCancel（失焦划掉倒计时）→ 到期 overlay 的防绕过参考 |
| Flow activeSession 记账 | `capElapsed`、心跳兜底 flush、visibilitychange 即时结算、多 tab 去重（domain+tabId 校验）→ 原样吸收为 Session `actualSeconds` 的累加器设计 |
| Flow idle 防抖 | "心跳新鲜则忽略 idle"、锁屏/休眠分别计 0/全额 → §十一 的验收标准直接对应 |
| Flow 存储分层 | sync/local/session/IndexedDB 四层职责 → WhyTime 简化为 local（设置+activeSession+sessions）+ 后续 IDB，但"瞬态不进长期存储"的原则保留 |
| Flow 主题 token | CSS 变量 + html.light 类切换 + 强调色三件套 + tabular-nums → Phase 4 自写样式时照这个语言（不复制文件） |

### 4.3 新写（现有项目确实没有，四问作答）

**① 需求门 overlay（Phase 1 核心）**
- LeechBlock 已有？——只有点击即消失的 alert 容器和 CSS 滤镜，无表单收集。
- Flow 已有可参考实现？——cooldown overlay（site-tracker.js L410-586）是"全屏遮罩+按钮放行"，结构最接近，但无输入表单（GPLv3，只看结构不抄代码）。
- 能否抽取现有模块？——容器/样式模式可从 LBNG content.css 抽；表单与流程必须新写。
- 为什么必须新写？——"收集原因/用途/预算 → 创建 Session"是产品本体，两个项目都没有。

**② Session 生命周期 + 到期 overlay + 有限续时（Phase 2）**
- LeechBlock 已有？——`applyOverride` 的周期计数限额（orln/orlps/orlc）与"最多续时 2 次"同构；`allowedEndTime` 就是 plannedEndTime 的雏形；但没有 per-visit 独立记录、没有到期回访交互。
- Flow 已有？——session_limit（连用 X 秒冷却 Y 秒）是另一形态，无续时概念。
- 能否抽取？——计数器逻辑照 applyOverride 改造成 per-session；到期 UI 新写（复用 overlay 容器）。
- 为什么必须新写？——Session 四态（active/expired/ended/cancelled）+ 续时次数是全新状态机。

**③ Session 历史与统计聚合（Phase 3）**
- LBNG stats.js 只有每 set 聚合数；Flow 的 day 行模型可参考但没有"计划 vs 实际"与"用途"维度。
- 第一阶段用 storage.local 一个按月分 key 的 sessions 数组即可（每条 ~200B，一天几十条，一年 <2MB）；IndexedDB 留到数据量证明需要时（Flow db.js 结构届时可直接参考）。
- 聚合采用 Flow 的思路：存储只存原始 session，统计现场聚合（今日/7 日/按域名/按用途/计划 vs 实际）。

**④ Flow 风格设置页（Phase 4）**
- LBNG options.html 是 jQuery UI 老式表单（34.8KB 单页 6 个 set），不适合在上面长出 WhyTime 的信息架构；schema 驱动 + cleanOptions + 导入导出的**逻辑**复用，UI 重写为无依赖 HTML（Flow 风）。
- 为什么必须新写？——受众是"概览/网站规则/使用记录/统计分析/设置"五段式，与 LBNG 表单结构无对应关系。

### 4.4 计时与到期机制（设计主张，回应 §五 / §十九）

1. **不用 offscreen ticker**（LBNG 的每秒扫描对"时间预算"场景是过度设计）：剩余时间由 content script 本地 `setInterval(1s)` 渲染（页面活着浮层才活着，天然合理）。
2. **到期判定双保险**：content script 每秒比较 `plannedEndTime - Date.now()`，一到点立即向 SW 发消息请求结算并弹 overlay——即使 alarms 迟到或 SW 已死也能触发；SW 侧另建 `chrome.alarms.create({when: plannedEndTime×1000})` 作为唤醒兜底。
3. **Session 状态唯一权威在 storage.local**，页面只是投影：刷新/关 tab 重开 → content script 重新 loaded → SW 查到该域名 active/expired session → 直接恢复浮层或弹到期 overlay（防绕过）；SW 重启 → 从 storage 恢复并重建 alarms；浏览器整个重启 → plannedEndTime 已是过去时 → 恢复时结算为 expired。§十九 的测试点全部覆盖。
4. actualSeconds 累加采用 Flow 口径：active tab + visible + 非 idle 才计，capElapsed 防休眠跳变，心跳兜底落盘（每分钟一次，防崩溃丢失过多）。

---

## 5. 数据设计草案（Phase 1/2 落地用）

```javascript
// chrome.storage.local: "whytime.settings"
{
  sites: "bilibili.com youtube.com ...",   // 复用 LBNG cleanSites/getRegExpSites
  matchSubdomains: false,
  durations: [5, 10, 20, 30, 45, 60],      // 分钟档位
  maxExtensions: 2,                         // 续时上限，不提供"无限"
  theme: ""
}

// chrome.storage.local: "whytime.activeSession"（单例，每分钟心跳落盘）
{
  id, domain, tabId, url,
  reason, purpose,             // 工作学习/信息查询/社交/娱乐/放松/其他
  plannedSeconds,              // 计划+续时累计
  startTime, plannedEndTime,   // epoch 毫秒，唯一计时权威
  actualSeconds,               // active+visible+非idle 累计
  extensionCount,
  status: "active" | "expired" | "ended" | "cancelled"
}

// chrome.storage.local: "whytime.sessions.2026-10"（按月分 key 的数组，结束/取消时 append）
```

统计口径：planned = plannedSeconds；actual = actualSeconds；超出 = actual − planned；今日按域名/用途 = 当天 session 的 actualSeconds 聚合。九字段的记录完全覆盖 §九 的历史需求。

---

## 6. Phase 1 施工建议（待确认后执行）

**基底策略（建议 A）**：从 LBNG 提取"骨架层"（manifest + common.js + background 事件骨架 + content.js 骨架）到 `Desktop\WhyTime\` 新项目，砍掉 sets 多套系统/times/lockdown/override/password/delayed/blocked 页面，加入 session 模块——"适配现有代码"而非在 30-set 重型系统里做减法，死代码少、MPL 头保留。备选方案 B（完整 fork LBNG + 把"理由门"做成 per-set 新选项）保留 LBNG 全部原有功能，但复杂度和测试面大得多；若你想两者兼得（保留 LBNG 作屏蔽工具 + 独立 WhyTime），也应先做 A。

**Phase 1 范围**：名单管理（设置页最简版：textarea + 添加/删除）→ content script 门控 overlay（原因/用途/时长表单）→ 创建 Session（写 storage.local）→ 放行 + 迷你浮层。验收 = §二十四 的 1-7 步。
**Phase 2 范围**：到期 overlay + 续时 + 上限 + 结算，按 §十九 清单测试（切 tab/刷新/关 tab/重启/锁屏/SW 重启）。
**纪律**：改前备份（WhyTime/ 自建 git 或 zip）；每阶段保持扩展可加载、可手动测试；blocked.html 不作为交互载体（LBNG 原文件不进新项目）。

---

## 7. 待确认 / 风险

1. **基底策略 A or B**（§6）——影响 Phase 1 第一刀怎么切。
2. 名单匹配默认 `matchSubdomains=false`（LBNG 默认值，子域不匹配）；`bilibili.com` 是否要覆盖 `space.bilibili.com`？建议设置项保留、默认开。
3. 多 tab 同域名：建议一个域名同时只允许一个 active session，其他同域 tab 只显示浮层（Phase 2 细化）。
4. SPA 路由（pushState 不触发 loaded）：SW 的 `tabs.onUpdated`（changeInfo.url）可感知，Phase 2 处理。
5. 续时按钮防连点 / overlay 防页面 CSS 干扰（LBNG 用内联 style + z-index 上限，照做）。
6. Flow 为 GPLv3：只吸收机制与视觉语言，所有代码自写；LBNG 复用文件保留 MPL-2.0 头并在文件头注明衍生。
