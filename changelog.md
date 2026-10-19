# Changelog

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
