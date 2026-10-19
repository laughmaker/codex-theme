#!/usr/bin/env node

// 官方 Codex/Work 额度用完后，仍允许使用第三方模型继续对话。
//
// 背景（已在 Codex 26.1013.40934 + magpie 代理上实测确认）：
//   Codex 桌面端的「发送按钮禁用」完全是客户端 UI 判定。其数据来源是
//   app-server 下发的用量状态（rate_limit.limit_reached），一旦官方 5h /
//   周额度用尽，该值变为 true，输入框右侧的 Send 按钮就被禁用，且与当前
//   选择的模型无关——切到第三方模型（magpie 代理）也一样点不动。
//   但 openai_base_url 指向的本地代理仍能正常服务第三方模型请求，
//   所以这里只需要解除 UI 侧的门禁，不涉及任何服务端配额。
//   官方模型的服务端配额校验不受影响，仍会正常报错。
//
// 工作方式：
//   通过本机 CDP（127.0.0.1:9341）在 Codex 页面内常驻一个观察器，
//   持续检查渲染器持有的用量状态对象；一旦发现
//   rate_limit.limit_reached === true 且当前模型不是官方模型，
//   就把该状态就地改写为未限流，并触发一次重渲染。
//   Codex 每次刷新用量状态会重新下发新值，观察器会再次改写，
//   因此可在整个会话内持续生效，直到 Codex 退出。
//
//   注意：本脚本只改写界面门禁。账户菜单中的用量数字由服务端快照渲染，
//   不会被本脚本改变，因此菜单仍会如实显示额度已用尽。
//   如需完全移除：node script/codex-unblock-third-party.mjs restore
//
// 用法：
//   node script/codex-unblock-third-party.mjs apply    # 安装 / 更新观察器
//   node script/codex-unblock-third-party.mjs status   # 查看当前状态
//   node script/codex-unblock-third-party.mjs restore  # 移除观察器

const HOST = "127.0.0.1";
const PORT = 9341;
const STATE_KEY = "__localCodexThirdPartyUnblock";
const command = process.argv[2] ?? "status";

// 官方模型前缀：这些仍走官方额度，保持门禁，交由服务端返回真实限流错误。
const OFFICIAL_PREFIXES = ["gpt-", "codex/", "o1", "o3", "o4"];
const CHECK_INTERVAL = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function targets() {
  const response = await fetch(`http://${HOST}:${PORT}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`CDP 返回 HTTP ${response.status}`);
  const items = await response.json();
  return items.filter((item) => {
    if (!["page", "webview"].includes(item.type) || !item.webSocketDebuggerUrl) return false;
    try {
      // 仅信任官方签名的 Codex 外壳窗口；排除沙箱与各类浮层。
      const page = new URL(item.url);
      if (page.protocol !== "app:" || page.hostname !== "-" ||
          !["/index.html", "/detached-window.html"].includes(page.pathname)) return false;
      const route = page.searchParams.get("initialRoute");
      if (route && !["/", "/detached-window"].includes(route)) return false;
      const socket = new URL(item.webSocketDebuggerUrl);
      return socket.protocol === "ws:" && socket.hostname === HOST && Number(socket.port) === PORT;
    } catch { return false; }
  });
}

async function evaluate(target, expression, timeout = 10_000) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket 连接失败")); }, { once: true });
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP 页面操作超时")), timeout);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails) {
          reject(new Error(message.error?.message ??
            message.result.exceptionDetails.exception?.description ??
            message.result.exceptionDetails.text ?? "页面脚本执行失败"));
        } else resolve(message.result?.result?.value);
      });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  } finally { socket.close(); }
}

// 以下函数会被序列化后在页面上下文中执行，因此不能引用外部作用域变量。
function installUnblock(stateKey, officialPrefixes, interval) {
  globalThis[stateKey]?.restore?.();

  const isOfficial = (model) => {
    if (!model) return true; // 无法判定模型时保守处理，保持门禁。
    const slug = String(model);
    return officialPrefixes.some((prefix) => slug === prefix || slug.startsWith(prefix));
  };

  const state = {
    installedAt: Date.now(),
    rewrites: 0,
    lastRewriteAt: 0,
    lastError: null,
    active: true,
  };

  // 渲染器把用量状态挂在某个组件的 usageBannerProps 上；
  // 遍历组件树即可拿到该状态对象的真实引用。
  const scan = () => {
    const root = globalThis.__codexRoot?._internalRoot?.current;
    if (!root) return null;
    const seen = new Set();
    let result = null;
    const walk = (node, depth) => {
      if (!node || seen.has(node) || result || depth > 700) return;
      seen.add(node);
      try {
        const props = node.memoizedProps;
        if (props?.usageBannerProps?.rateLimit) { result = props.usageBannerProps; return; }
      } catch { /* 忽略跨版本结构差异 */ }
      walk(node.child, depth + 1);
      walk(node.sibling, depth);
    };
    walk(root.child, 0);
    return result;
  };

  const tick = () => {
    if (!state.active) return;
    try {
      const usage = scan();
      const status = usage?.rateLimit;
      if (!status?.rate_limit) return;
      // 仅在额度确实用尽时介入，避免无谓改写。
      if (status.rate_limit.limit_reached !== true) return;
      // 官方模型保持门禁，由服务端返回真实限流错误。
      if (isOfficial(usage.selectedModel)) return;
      status.rate_limit.limit_reached = false;
      status.rate_limit.allowed = true;
      if (status.rate_limit_upsell) status.rate_limit_upsell = null;
      usage.sendBlocked = false;
      usage.sendBlockReason = null;
      state.rewrites += 1;
      state.lastRewriteAt = Date.now();
      // 触发一次尺寸事件，促使 React 重算提交按钮状态。
      globalThis.dispatchEvent(new Event("resize"));
    } catch (error) {
      state.lastError = String(error?.message ?? error);
    }
  };

  const timer = setInterval(tick, interval);
  state.restore = () => {
    clearInterval(timer);
    state.active = false;
    delete globalThis[stateKey];
  };
  tick();
  globalThis[stateKey] = state;
  return { installed: true, rewrites: state.rewrites };
}

const applyExpression =
  `(${installUnblock})(${JSON.stringify(STATE_KEY)}, ${JSON.stringify(OFFICIAL_PREFIXES)}, ${CHECK_INTERVAL})`;

const statusExpression = `(() => {
  const state = globalThis[${JSON.stringify(STATE_KEY)}] ?? null;
  const sendButtons = [...document.querySelectorAll('[data-codex-composer-root] button')]
    .filter(button => button.getAttribute('aria-label') === 'Send')
    .map(button => ({ disabled: button.disabled, ariaDisabled: button.getAttribute('aria-disabled') }));
  const root = window.__codexRoot?._internalRoot?.current;
  let usage = null;
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || seen.has(node) || usage || depth > 700) return;
    seen.add(node);
    try {
      const props = node.memoizedProps;
      if (props?.usageBannerProps?.rateLimit) {
        usage = {
          model: props.usageBannerProps.selectedModel ?? null,
          limitReached: props.usageBannerProps.rateLimit.rate_limit?.limit_reached ?? null,
          sendBlocked: props.usageBannerProps.sendBlocked ?? null,
        };
        return;
      }
    } catch {}
    walk(node.child, depth + 1); walk(node.sibling, depth);
  };
  if (root) walk(root.child, 0);
  return {
    installed: Boolean(state?.active),
    rewrites: state?.rewrites ?? 0,
    lastRewriteAt: state?.lastRewriteAt ?? 0,
    lastError: state?.lastError ?? null,
    usage,
    sendButtons,
  };
})()`;

const restoreExpression = `(() => {
  globalThis[${JSON.stringify(STATE_KEY)}]?.restore?.();
  return { installed: false };
})()`;

async function operate(expression) {
  const pages = await targets();
  if (!pages.length) throw new Error("没有找到可信的 Codex 页面；请先启动 Codex。");
  const results = await Promise.all(pages.map(async (target) => {
    const identity = { targetId: target.id, targetKind: target.type, targetUrl: target.url };
    try { return { ...identity, ...await evaluate(target, expression) }; }
    catch (error) { return { ...identity, error: error.message }; }
  }));
  if (results.some((result) => result.error)) process.exitCode = 1;
  return results;
}

async function waitForComposer(deadline) {
  while (Date.now() < deadline) {
    const pages = await targets();
    for (const page of pages) {
      const ready = await evaluate(page,
        `document.querySelectorAll('[data-codex-composer-root]').length > 0`).catch(() => false);
      if (ready) return true;
    }
    await sleep(300);
  }
  return false;
}

async function main() {
  if (!["apply", "status", "restore"].includes(command)) {
    throw new Error("用法：codex-unblock-third-party.mjs apply|status|restore");
  }
  if (command === "apply") {
    // 等待输入区渲染完成，确保观察器首次扫描就能拿到用量状态。
    await waitForComposer(Date.now() + 20_000);
    await operate(applyExpression);
    await sleep(1000);
  } else if (command === "restore") {
    await operate(restoreExpression);
  }
  const results = await operate(statusExpression);
  console.log(JSON.stringify({ command, port: PORT, results }, null, 2));
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exitCode = 1;
});