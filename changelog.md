# Changelog

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
