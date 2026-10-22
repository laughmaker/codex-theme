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
// 守护进程的页面轮询间隔。
const WATCH_INTERVAL = 2000;

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
    // 前缀后必须是非字母数字，避免把 opencode-zen 之类的第三方名误判为官方 o1/o3。
    return officialPrefixes.some((prefix) => {
      if (!slug.startsWith(prefix)) return false;
      const rest = slug.slice(prefix.length);
      return rest === "" || !/[a-z0-9]/i.test(rest[0]);
    });
  };

  const state = {
    installedAt: Date.now(),
    rewrites: 0,
    lastRewriteAt: 0,
    lastDispatched: 0,
    lastError: null,
    models: [],
    scans: 0,
    active: true,
  };

  // 渲染器把用量状态挂在多个组件的 usageBannerProps 上。
  // 首页与每个会话各自持有一份，因此必须全部收集。
  // 完整遍历 React 树开销较大，因此结果会被缓存，仅在缓存失效时重扫。
  const cache = { usages: [], models: [], expiresAt: 0 };

  const scanAll = () => {
    const now = Date.now();
    if (now < cache.expiresAt) return cache.usages;
    const root = globalThis.__codexRoot?._internalRoot?.current;
    if (!root) return [];
    const seen = new Set();
    const found = [];
    const walk = (node, depth) => {
      if (!node || seen.has(node) || depth > 900) return;
      seen.add(node);
      try {
        const props = node.memoizedProps;
        if (props?.usageBannerProps?.rateLimit) found.push(props.usageBannerProps);
      } catch { /* 忽略跨版本结构差异 */ }
      walk(node.child, depth + 1);
      walk(node.sibling, depth);
    };
    walk(root.child, 0);
    // 同一份 usageBannerProps 会被多个组件共享，按对象去重。
    cache.usages = [...new Set(found)];
    cache.expiresAt = now + 2000;
    state.scans += 1;
    return cache.usages;
  };

  // 当前实际使用的模型以模型选择器为准：
  // usageBannerProps.selectedModel 是默认模型，不会随用户切换而更新。
  const currentModel = () => {
    const now = Date.now();
    if (now < cache.expiresAt && cache.models.length) return cache.models[0];
    const root = globalThis.__codexRoot?._internalRoot?.current;
    if (!root) return null;
    const seen = new Set();
    let model = null;
    const walk = (node, depth) => {
      if (!node || seen.has(node) || model || depth > 900) return;
      seen.add(node);
      try {
        const props = node.memoizedProps;
        const picked = props?.selectedPowerSelection?.model ?? props?.selectedLabelCandidate?.model;
        if (typeof picked === "string" && picked) { model = picked; return; }
      } catch { /* 忽略 */ }
      walk(node.child, depth + 1);
      walk(node.sibling, depth);
    };
    walk(root.child, 0);
    cache.models = model ? [model] : [];
    return model;
  };

  // Codex 还会额外把发送按钮本身的 disabled 属性置为 true。
  // 按钮的 disabled 由 composer 内部的提交状态决定，与用量状态不是同一处，
  // 因此这里同时把按钮恢复为可点击，React 下一次重绘时会被再次修正。
  const enableSendButton = () => {
    let touched = false;
    for (const button of document.querySelectorAll('[data-codex-composer-root] button')) {
      if (button.getAttribute("aria-label") !== "Send") continue;
      if (button.disabled) {
        button.disabled = false;
        button.removeAttribute("disabled");
        button.setAttribute("aria-disabled", "false");
        touched = true;
      }
      const propsKey = Object.keys(button).find((key) => key.startsWith("__reactProps$"));
      if (propsKey) {
        const props = button[propsKey];
        if (props?.disabled) {
          button[propsKey] = { ...props, disabled: false, "aria-disabled": "false" };
          touched = true;
        }
      }
    }
    return touched;
  };

  // 用量状态由 react-query 的 rate-limit-status 查询驱动。
  // 直接改写对象字段不会通知订阅者，Codex 内部据此派生的
  // hardBlocked 选择器仍会保持 true，发送按钮就一直是禁用的。
  // 因此必须经由 setQueryData 写入新对象，让订阅者重新计算。
  const RATE_LIMIT_QUERY_KEY = ["rate-limit-status"];

  const findQueryClient = () => {
    const root = globalThis.__codexRoot?._internalRoot?.current;
    if (!root) return null;
    const seen = new Set();
    let client = null;
    const walk = (node, depth) => {
      if (!node || seen.has(node) || client || depth > 900) return;
      seen.add(node);
      try {
        let ctx = node.dependencies?.firstContext;
        let guard = 0;
        while (ctx && guard++ < 80) {
          const value = ctx.memoizedValue;
          if (value && typeof value === "object" &&
              typeof value.setQueryData === "function" &&
              typeof value.getQueryCache === "function") {
            client = value;
            return;
          }
          ctx = ctx.next;
        }
      } catch { /* 忽略 */ }
      walk(node.child, depth + 1);
      walk(node.sibling, depth);
    };
    walk(root.child, 0);
    return client;
  };

  const patchRateLimitQuery = (client) => {
    if (!client) return false;
    const current = client.getQueryData(RATE_LIMIT_QUERY_KEY);
    if (!current?.rate_limit) return false;
    // Codex 会把 hardBlocked 的结果留在 composer 的渲染闭包里，
    // 只改字段不会让它重算，必须让订阅者收到一次通知。
    // 因此每次都写入新的对象标识，React 才会重新渲染并刷新门禁。
    const alreadyOpen = current.rate_limit.allowed === true &&
      current.rate_limit.limit_reached === false &&
      current.rate_limit_reached_type == null &&
      current.rate_limit_upsell == null;
    // 门禁已放开时降低写入频率，避免持续重渲染。
    if (alreadyOpen && Date.now() - (state.lastQueryWriteAt ?? 0) < 1500) return false;
    client.setQueryData(RATE_LIMIT_QUERY_KEY, {
      ...current,
      rate_limit: { ...current.rate_limit, allowed: true, limit_reached: false },
      rate_limit_reached_type: null,
      rate_limit_upsell: null,
    });
    state.lastQueryWriteAt = Date.now();
    return true;
  };

  const tick = () => {
    if (!state.active) return;
    try {
      const pickerModel = currentModel();
      // 当前使用的模型是官方模型时不做任何改写，由服务端返回真实限流错误。
      const usages = scanAll();
      const targetModel = usages[0]?.selectedModel ?? pickerModel;
      if (targetModel && isOfficial(targetModel)) {
        state.skippedOfficial = true;
        return;
      }
      state.skippedOfficial = false;
      let changed = false;
      // 1) 放开用量状态本身
      if (patchRateLimitQuery(findQueryClient())) {
        changed = true;
        state.rewrites += 1;
        state.lastRewriteAt = Date.now();
      }
      // 2) usageBannerProps 上的开关（sendBlocked 与 limit_reached 相互独立）
      for (const usage of usages) {
        const status = usage?.rateLimit;
        if (!status?.rate_limit) continue;
        const model = usage.selectedModel ?? pickerModel;
        if (model && isOfficial(model)) continue;
        if (status.rate_limit.limit_reached === true ||
            status.rate_limit_reached_type != null) {
          status.rate_limit_reached_type = null;
          status.rate_limit.limit_reached = false;
          status.rate_limit.allowed = true;
          if (status.rate_limit_upsell) status.rate_limit_upsell = null;
          changed = true;
        }
        if (usage.sendBlocked === true || usage.sendBlockReason != null) {
          usage.sendBlocked = false;
          usage.sendBlockReason = null;
          changed = true;
        }
      }
      if (targetModel && !state.models.includes(targetModel)) {
        state.models = [...state.models, targetModel];
      }
      // 3) 发送按钮本身也要恢复可点击
      if (enableSendButton()) changed = true;
      if (changed && state.rewrites !== state.lastDispatched) {
        state.lastDispatched = state.rewrites;
        globalThis.dispatchEvent(new Event("resize"));
      }
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
  const usages = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || seen.has(node) || depth > 900) return;
    seen.add(node);
    try {
      const props = node.memoizedProps;
      if (props?.usageBannerProps?.rateLimit) {
        usages.push({
          model: props.usageBannerProps.selectedModel ?? null,
          limitReached: props.usageBannerProps.rateLimit.rate_limit?.limit_reached ?? null,
          reachedType: props.usageBannerProps.rateLimit.rate_limit_reached_type ?? null,
          sendBlocked: props.usageBannerProps.sendBlocked ?? null,
        });
      }
    } catch {}
    walk(node.child, depth + 1); walk(node.sibling, depth);
  };
  if (root) walk(root.child, 0);
  const unique = [...new Map(usages.map((entry) => [JSON.stringify(entry), entry])).values()];
  return {
    installed: Boolean(state?.active),
    rewrites: state?.rewrites ?? 0,
    models: state?.models ?? [],
    lastRewriteAt: state?.lastRewriteAt ?? 0,
    lastError: state?.lastError ?? null,
    usage: unique,
    sendButtons,
  };
})()`;

const restoreExpression = `(() => {
  globalThis[${JSON.stringify(STATE_KEY)}]?.restore?.();
  return { installed: false };
})()`;

// 判断某个页面是否已经装载观察器（用于守护进程决定是否需要重新注入）。
const installedExpression = `Boolean(globalThis[${JSON.stringify(STATE_KEY)}]?.active)`;

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

// 守护进程：持续监视页面 target，一旦发现新的（重载后的）页面缺少观察器，
// 就重新注入。这样 Codex 崩溃重启、页面重载、多开窗口都能自动恢复。
async function watch() {
  console.log(`[watch] 监控 ${HOST}:${PORT}，每 ${WATCH_INTERVAL / 1000}s 检查一次；Ctrl+C 退出。`);
  const known = new Map();
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  while (!stopping) {
    try {
      const pages = await targets();
      const seenIds = new Set();
      for (const page of pages) {
        seenIds.add(page.id);
        const already = known.get(page.id);
        if (already) continue;
        // 新出现的页面：等待输入区就绪后注入观察器。
        const ready = await waitForComposer(Date.now() + 15_000);
        if (!ready) continue;
        const result = await evaluate(page, applyExpression);
        known.set(page.id, Date.now());
        console.log(`[watch] 已为 ${page.id.slice(0, 8)} 安装观察器：${JSON.stringify(result)}`);
      }
      // 清理已消失的 target。
      for (const id of [...known.keys()]) if (!seenIds.has(id)) known.delete(id);
    } catch (error) {
      // Codex 未启动时 target 列表为空属于正常情况。
    }
    await sleep(WATCH_INTERVAL);
  }
  console.log("[watch] 已退出。");
}

async function main() {
  if (!["apply", "status", "restore", "watch"].includes(command)) {
    throw new Error("用法：codex-unblock-third-party.mjs apply|status|restore|watch");
  }
  if (command === "watch") {
    await watch();
    return;
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