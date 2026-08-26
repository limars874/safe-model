import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Input, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { completeSimple, type Message } from "@earendil-works/pi-ai/compat";

const PROBE_MARKER = "PI_MODEL_PROBE_OK";
const PROBE_TIMEOUT_MS = 45_000;
const PROBE_MAX_TOKENS = 64;
const MAX_ERROR_DETAIL_LENGTH = 400;

const HTTP_STATUS_REASONS: Record<number, string> = {
  400: "请求参数不被 provider 接受",
  401: "认证失败或凭据已失效",
  402: "余额不足",
  403: "无权访问该模型",
  404: "模型或接口不存在",
  408: "请求超时",
  413: "请求内容超过 provider 限制",
  422: "请求内容无法处理",
  429: "请求频率或额度受限",
  500: "provider 内部错误",
  502: "provider 网关错误",
  503: "provider 暂时不可用",
  504: "provider 响应超时",
};

type ModelCandidate = {
  key: string;
  label: string;
  searchText: string;
  model: Parameters<ExtensionAPI["setModel"]>[0];
};

type ProbeFailure = {
  ok: false;
  category: "cancelled" | "auth" | "provider" | "response";
  reason: string;
  detail?: string;
  status?: number;
};

type ProbeResult =
  | { ok: true }
  | ProbeFailure;

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function matchesQuery(candidate: ModelCandidate, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => candidate.searchText.includes(term));
}

function limitErrorDetail(detail: string): string {
  return detail.length > MAX_ERROR_DETAIL_LENGTH
    ? `${detail.slice(0, MAX_ERROR_DETAIL_LENGTH - 3)}...`
    : detail;
}

function extractStatus(message: string): number | undefined {
  const match = message.match(/(?:^|\D)([1-5]\d{2})(?=\D|$)/);
  return match ? Number(match[1]) : undefined;
}

function extractProviderDetail(message: string): string {
  const jsonStart = message.indexOf("{");
  if (jsonStart !== -1) {
    try {
      const payload = JSON.parse(message.slice(jsonStart)) as Record<string, unknown>;
      const details = [
        typeof payload.message === "string" ? payload.message : undefined,
        typeof payload.type === "string" ? `类型: ${payload.type}` : undefined,
        typeof payload.code === "string" ? `代码: ${payload.code}` : undefined,
      ].filter((detail): detail is string => Boolean(detail));
      if (details.length > 0) return details.join("\n");
    } catch {
      // 回退到 provider 返回的原始文本。
    }
  }

  return message;
}

function providerFailure(errorMessage: string | undefined, fallback: string): ProbeFailure {
  const message = errorMessage?.trim() || fallback;
  const status = extractStatus(message);
  return {
    ok: false,
    category: "provider",
    reason: status ? (HTTP_STATUS_REASONS[status] ?? "provider 请求失败") : fallback,
    detail: limitErrorDetail(extractProviderDetail(message)),
    status,
  };
}

async function probeModel(
  ctx: ExtensionCommandContext,
  candidate: ModelCandidate,
  signal: AbortSignal,
): Promise<ProbeResult> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate.model);
  if (!auth.ok) {
    return {
      ok: false,
      category: "auth",
      reason: "无法取得模型凭据",
      detail: limitErrorDetail(auth.error),
    };
  }

  const message: Message = {
    role: "user",
    content: [{ type: "text", text: `Reply with exactly: ${PROBE_MARKER}` }],
    timestamp: Date.now(),
  };
  const response = await completeSimple(
    candidate.model,
    { systemPrompt: "Return only the requested probe marker.", messages: [message] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxRetries: 0,
      maxTokens: PROBE_MAX_TOKENS,
    },
  );
  if (response.stopReason === "aborted") {
    return { ok: false, category: "cancelled", reason: "探测已取消" };
  }
  if (response.stopReason !== "stop") {
    return providerFailure(response.errorMessage, "provider 未完成探测响应");
  }

  const text = response.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
  return text.includes(PROBE_MARKER)
    ? { ok: true }
    : {
        ok: false,
        category: "response",
        reason: "未收到模型确认响应",
        detail: text ? limitErrorDetail(text) : "响应中没有文本内容",
      };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("safe-model", {
    description: "探测并切换模型；/safe-model . 直接检测当前模型",
    handler: async (args, ctx) => {
      // 先重载 models.json，确保拿到最新的 provider/模型列表
      await ctx.modelRegistry.refresh();
      const candidates: ModelCandidate[] = ctx.modelRegistry.getAvailable()
        .map((model) => {
          const key = modelKey(model);
          return {
            key,
            label: key,
            searchText: `${key} ${model.name ?? ""}`.toLowerCase(),
            model,
          };
        })
        .sort((left, right) => left.label.localeCompare(right.label));

      if (candidates.length === 0) {
        ctx.ui.notify("没有已配置凭据的模型", "warning");
        return;
      }

      const currentKey = ctx.model ? modelKey(ctx.model) : undefined;

      let selected: ModelCandidate | undefined;
      const trimmed = args.trim();
      if (trimmed) {
        selected = candidates.find((c) => {
          if (trimmed === ".") return c.key === currentKey;
          return c.key === trimmed;
        });
        if (!selected) {
          ctx.ui.notify(`未找到模型 "${trimmed}"；使用 /safe-model 从列表选择`, "warning");
          return;
        }
      } else {
        const selectedKey = await pickModel(ctx, candidates, currentKey);
        if (!selectedKey) return;
        selected = candidates.find((candidate) => candidate.key === selectedKey);
        if (!selected) return;
      }

      await runProbe(pi, ctx, selected);
    },
  });
}

async function runProbe(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  selected: ModelCandidate,
): Promise<void> {
  const outcome = await ctx.ui.custom<ProbeResult | null>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, `正在探测 ${selected.key}…`);
    loader.onAbort = () => done(null);
    probeModel(ctx, selected, loader.signal)
      .then(done)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err ?? "");
        done(providerFailure(message, "请求失败或超时"));
      });
    return loader;
  });

  if (outcome === null || (!outcome.ok && outcome.category === "cancelled")) {
    ctx.ui.notify("探测已取消，当前模型未切换", "info");
    return;
  }
  if (!outcome.ok) {
    await showProbeFailure(ctx, selected, outcome);
    return;
  }

  const switched = await pi.setModel(selected.model);
  if (!switched) {
    ctx.ui.notify(`${selected.key} 探测成功，但 Pi 未能应用该模型`, "error");
    return;
  }

  ctx.ui.notify(`已切换到 ${selected.key}`, "info");
}

async function showProbeFailure(
  ctx: ExtensionCommandContext,
  selected: ModelCandidate,
  failure: ProbeFailure,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("error", text)));
    container.addChild(new Text(theme.fg("error", theme.bold("模型探测失败")), 1, 0));
    container.addChild(new Text(`模型  ${selected.key}`, 1, 0));
    container.addChild(
      new Text(
        failure.status
          ? theme.fg("warning", `状态  HTTP ${failure.status} · ${failure.reason}`)
          : theme.fg("warning", `原因  ${failure.reason}`),
        1,
        0,
      ),
    );
    if (failure.detail) {
      container.addChild(new Text(theme.fg("muted", `详情  ${failure.detail}`), 1, 0));
    }
    container.addChild(new Text(theme.fg("dim", "Enter 或 Esc 关闭 · 当前模型未切换"), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg("error", text)));

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (
          keybindings.matches(data, "tui.select.confirm") ||
          keybindings.matches(data, "tui.select.cancel")
        ) {
          done();
        }
        tui.requestRender();
      },
    };
  });
}

async function pickModel(
  ctx: ExtensionCommandContext,
  candidates: ModelCandidate[],
  currentKey: string | undefined,
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const filterInput = new Input();
    const topBorder = new DynamicBorder((text: string) => theme.fg("accent", text));
    const bottomBorder = new DynamicBorder((text: string) => theme.fg("accent", text));
    const title = new Text(theme.fg("accent", theme.bold("安全切换模型")), 1, 0);
    const filterHint = new Text(theme.fg("dim", "搜索 provider、model 或名称；Enter 探测并切换"), 1, 0);
    const help = new Text(theme.fg("dim", "↑↓ 选择 · Enter 确认 · Esc 取消"), 1, 0);

    let selectList: SelectList;
    const createSelectList = (): SelectList => {
      const query = filterInput.getValue();
      const items: SelectItem[] = candidates
        .filter((candidate) => matchesQuery(candidate, query))
        .map((candidate) => ({
          value: candidate.key,
          label: candidate.label,
          description: candidate.key === currentKey ? "当前模型" : undefined,
        }));
      const list = new SelectList(items, Math.min(Math.max(items.length, 1), 10), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      return list;
    };

    const refreshList = () => {
      const index = container.children.indexOf(selectList);
      selectList = createSelectList();
      if (index === -1) {
        container.addChild(selectList);
      } else {
        container.children.splice(index, 1, selectList);
      }
    };

    selectList = createSelectList();
    container.addChild(topBorder);
    container.addChild(title);
    container.addChild(filterHint);
    container.addChild(filterInput);
    container.addChild(selectList);
    container.addChild(help);
    container.addChild(bottomBorder);

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (data === "\u001b" || data === "\u0003") {
          done(null);
        } else if (data.startsWith("\u001b[")) {
          selectList.handleInput(data);
        } else {
          const submitAt = data.search(/[\r\n]/);
          if (submitAt === -1) {
            filterInput.handleInput(data);
            refreshList();
          } else {
            const typed = data.slice(0, submitAt);
            if (typed) {
              filterInput.handleInput(typed);
              refreshList();
            }
            selectList.handleInput("\r");
          }
        }
        tui.requestRender();
      },
    };
  });
}
