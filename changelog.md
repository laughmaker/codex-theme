# Changelog

## 2026-10-29

- 修复浅色模式侧边栏「看不清」的问题，改动集中在 `codex-theme.mjs` 的 `themeCss`，仅作用于 `[data-theme="light"]`，深色模式样式未改。
- 根因：Codex 原生的次要文字只有约 49% 墨色（`--color-text-tertiary: rgba(26,28,31,.495)`），而本主题此前又把侧边栏 `.text-default` 统一压成 68% 墨色，再叠加磨砂背景透出的桌面壁纸，标签与分区标题都偏灰。
- 标签对比度：行标签改为 `rgba(17,19,22,.94)`、字重提到 500（应用名 `Codex` 标题保持原生 600），分区标题 `Projects` / `Recents` 改为 74% 墨色、字重 600。
- 背景稳定性：浅色磨砂层不透明度由 `.927 / .907` 提到 `.968 / .955`，壁纸透出更少，侧边栏底色由上到下 226→211 的落差收窄到 240→234；在面板右缘补一条 `inset -1px 0 0 rgba(26,28,31,.10)` 发丝线，避免与白色主内容区融为一体。
- 选中与悬停：选中会话行底色由 `rgba(26,28,31,.055)` 提到 `.10`，并在侧边栏作用域内补出 `--color-primary-ghost-hover`、`--color-text-secondary`、`--color-text-tertiary`，导航栏图标与 `Show more` 一并清晰。
- 实测（Codex 浅色模式，CDP 截取侧边栏逐像素取背景色后按 WCAG 计算）：行标签对比度 5.2:1 → 14.3:1，分区标题 3.0:1 → 7.2:1。`node codex-theme.mjs apply` 后两个窗口均 `applied: true`、行标签 500、标题 600、选中行底色已生效。
- 未验证：深色模式视觉（本次未切换外观，仅确认深色 CSS 规则未被修改）；Codex 升级后 `.text-tertiary`、`data-app-action-sidebar-thread-selected` 等选择器是否仍成立。

## 2026-10-22（第二次修正：找到真正的门禁）

- 定位到发送按钮真正被禁用的位置：`Xht` 组件里的 `Ct = Q(MVe, yt)`，即 `Aco`/`jco` 限流硬阻塞选择器；它由 `rate_limit.allowed === false` 派生，**禁用时不设置 `submitBlockReason`**，所以按钮变灰但没有任何提示文案。
- 关键修正：此前直接在 `usageBannerProps.rateLimit` 对象上改字段无效——那只是缓存里的一份引用，Codex 内部的选择器不会重新计算。
- 改为通过 React Query 的 `setQueryData(["rate-limit-status"])` 写入新的对象标识：`allowed: true`、`limit_reached: false`、`rate_limit_reached_type: null`、`rate_limit_upsell: null`。订阅者收到通知后才会重算 `hardBlocked`。
- 由于 Codex 会把 `hardBlocked` 结果留在 composer 的渲染闭包里，单次写入会被后续重绘覆盖，因此每 1.5 秒重新写入一次以保持门禁放开。
- 实测（Codex 26.1013.40934）：切入 `workbuddy/glm-5.3` 后 `Pht.submitDisabled` 由 `true` 稳定变为 `false`、`Ntt.submitDisabled` 同步为 `false`、`submitBlockReason` 只剩正常的 `empty-message`；连续 24 秒三次采样保持稳定；渲染进程 CPU 约 9%。
- 切回官方模型（`gpt-*`）时不写入任何改动，仍由服务端返回真实限流错误。
- 仍未解决的外部问题：本机 `chatgpt.com` 不可达、Codex 后端 `4.78.139.50:443` 连接被拒，`durable` 主机持续重连失败，与限流无关；同时段经 magpie 直连 `workbuddy/glm-5.3` 返回正常。

## 2026-10-22

- 修正 `script/codex-unblock-third-party.mjs` 的两个问题，使其能正确处理多 composer 与整套限流字段。
- 按实例判断模型：首页与每个会话各自持有一份 `usageBannerProps`，原先只取第一份，导致切到第三方模型后仍按官方模型保持门禁。
- 补充清除 `rate_limit_reached_type` 与 `sendBlocked`/`sendBlockReason`：`sendBlocked` 由 `blocked_features` 派生，与 `rate_limit.limit_reached` 相互独立，只清后者不足以放开发送按钮。
- 发送按钮本身也恢复可点击（DOM 属性与 React props 同时处理），否则即使数据已放开，按钮仍是禁用态。
- 状态输出改为按实例汇总，新增 `models`、`reachedType` 字段便于排查。
- 补齐 `watch` 模式与守护进程，页面重载或 Codex 重启后自动重新注入。
- 性能：React 树遍历结果增加缓存，避免此前每 400ms 全树扫描造成的渲染进程高 CPU。
- 实测（Codex 26.1013.40934）：切到 `workbuddy/glm-5.3` 后 `limitReached: false`、`reachedType: null`、`sendBlocked: false`，发送按钮 `disabled: false`，限流横幅消失；切回 `gpt-*` 仍保持门禁。
- 另行确认：本机当前 `chatgpt.com` 不可达、Codex 后端的 `4.78.139.50:443` 连接被拒，`durable` 主机持续重连失败（`reconnectAttempt` 已上百次），点击发送不会产生 `turn/start` 请求。此时消息发不出去与限流无关，属于网络不可达；同一时刻经 magpie 直连 `workbuddy/glm-5.3` 可正常返回。
- 未验证：网络恢复后，第三方模型能否在同一次会话内完整走完发送与流式回复。

## 2026-10-19

- 修复官方 Codex/Work 额度用尽后第三方模型无法使用的问题：新增 `script/codex-unblock-third-party.mjs`，把发送按钮的 UI 门禁放开，使第三方模型在官方额度耗尽时仍可发送。
- 根因：Codex 桌面端在客户端根据 `rate_limit.limit_reached` 判定 `sendBlocked`，与所选模型无关；而 `openai_base_url` 指向的本地代理（magpie）本身能正常服务第三方模型。
- 仅解除界面门禁，官方模型仍保持门禁并由服务端返回真实限流错误；账户菜单中的用量数字不受影响。
- Dock 启动器 `script/Codex Theme.applescript` 现在在应用主题后依次执行 unblock apply。
- 实测：`gpt-6.1-sol`、`codex/gpt-6-luna` 仍为 `sendBlocked: true`；`group/max`、`deepseek/deepseek-flash`、`workbuddy/glm-5.3` 为 `sendBlocked: false`，发送按钮 `disabled: false`。
- 未验证：完整应用冷启动后自动恢复；DeepSeek 账户本身余额不足（402）属于代理侧独立问题，与本修复无关。

## 2026-10-04

- Wait for each Codex shell page to finish loading and mount its document before running theme operations, to guard against startup timing failures.
- Report the CDP exception description and stack instead of only `Uncaught`.
- Changed `codex-theme.mjs`. Verified syntax, diff formatting, readiness polling and timeout, and the installed `/Applications/Codex Theme.app` launcher. Both current shell windows report `applied: true` and `observerInstalled: true`.
- The original exception detail was not retained; its exact cause and a fresh cold launch remain unverified. The running app was kept open.
