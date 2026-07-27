/**
 * Status bar extension for pi.
 *
 * Renders a single footer line:
 *
 *   directory • provider/model-id • thinking • context-bar used/total • plan-bar % (resets …)
 *
 * The "plan usage" gauge reflects the provider's primary quota window (the
 * 5h rolling limit for Claude/Codex subscription plans). Usage is read from
 * the same OAuth credentials pi stores for `/login`, refreshed periodically
 * and opportunistically after each provider response.
 */

import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Provider usage (plan quota)
// ---------------------------------------------------------------------------

const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "https://claude.ai/oauth/claude-code-client-metadata";

const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const REFRESH_MS = 60_000; // poll provider usage every minute
const CACHE_TTL_MS = 55_000;
const USAGE_CACHE_PATH = homePath(".pi/agent/plan-usage-cache.json");

type ProviderId = "anthropic" | "openai-codex";

interface PlanUsage {
  // Percentage of the primary (5h) window that has been used, 0..100.
  usedPercent: number;
  fetchedAt: number;
  // Epoch milliseconds when the primary window resets, if known.
  resetsAtMs?: number;
}

interface AuthCredentials {
  provider: ProviderId;
  source: "pi" | "codex";
  path: string;
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  expiresAtMs?: number;
}

function homePath(relative: string): string {
  return join(process.env.HOME || process.env.USERPROFILE || ".", relative);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function readAuthFile(
  source: "pi" | "codex",
  path: string,
  provider: ProviderId,
): Promise<AuthCredentials | undefined> {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const obj = objectValue(parsed);
    if (!obj) return undefined;
    raw = obj;
  } catch {
    return undefined;
  }

  if (source === "pi") {
    const entry = objectValue(raw[provider]);
    const accessToken = stringValue(entry?.access);
    if (!accessToken) return undefined;
    return {
      provider,
      source: "pi",
      path,
      accessToken,
      refreshToken: stringValue(entry?.refresh),
      accountId: stringValue(entry?.accountId),
      expiresAtMs: numberValue(entry?.expires),
    };
  }

  const tokens = objectValue(raw.tokens);
  const accessToken = stringValue(tokens?.access_token);
  if (!accessToken) return undefined;
  return {
    provider: "openai-codex",
    source: "codex",
    path,
    accessToken,
    refreshToken: stringValue(tokens?.refresh_token),
    accountId: stringValue(tokens?.account_id),
  };
}

async function resolveAuth(provider: ProviderId): Promise<AuthCredentials | undefined> {
  const pi = await readAuthFile("pi", homePath(".pi/agent/auth.json"), provider);
  if (pi) return refreshIfNeeded(pi);
  if (provider === "openai-codex") {
    const codex = await readAuthFile("codex", homePath(".codex/auth.json"), provider);
    if (codex) return refreshIfNeeded(codex);
  }
  return undefined;
}

async function refreshIfNeeded(auth: AuthCredentials): Promise<AuthCredentials> {
  if (!auth.refreshToken || !auth.expiresAtMs) return auth;
  if (auth.expiresAtMs > Date.now() + 5 * 60 * 1000) return auth;
  return refreshAuth(auth);
}

async function refreshAuth(auth: AuthCredentials): Promise<AuthCredentials> {
  if (!auth.refreshToken) return auth;
  const cfg =
    auth.provider === "anthropic"
      ? { clientId: CLAUDE_CLIENT_ID, tokenUrl: CLAUDE_TOKEN_URL }
      : { clientId: CODEX_CLIENT_ID, tokenUrl: CODEX_TOKEN_URL };

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken,
    client_id: cfg.clientId,
  }).toString();

  const response = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) return auth;
  const refreshed = objectValue(await response.json());
  const accessToken = stringValue(refreshed?.access_token);
  if (!accessToken) return auth;

  const expiresIn = numberValue(refreshed?.expires_in);
  const next: AuthCredentials = {
    ...auth,
    accessToken,
    refreshToken: stringValue(refreshed?.refresh_token) ?? auth.refreshToken,
    expiresAtMs: expiresIn !== undefined ? Date.now() + expiresIn * 1000 : auth.expiresAtMs,
  };
  await persistAuth(next).catch(() => undefined);
  return next;
}

async function persistAuth(auth: AuthCredentials): Promise<void> {
  const raw = objectValue(JSON.parse(await readFile(auth.path, "utf8")));
  if (!raw) return;
  if (auth.source === "pi") {
    const entry = objectValue(raw[auth.provider]);
    if (entry) {
      entry.access = auth.accessToken;
      if (auth.refreshToken) entry.refresh = auth.refreshToken;
      if (auth.expiresAtMs) entry.expires = auth.expiresAtMs;
    }
  } else {
    const tokens = objectValue(raw.tokens);
    if (tokens) {
      tokens.access_token = auth.accessToken;
      if (auth.refreshToken) tokens.refresh_token = auth.refreshToken;
    }
  }
  await mkdir(dirname(auth.path), { recursive: true });
  const tmp = `${auth.path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, auth.path);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

// Resolve a reset timestamp (epoch ms) from a variety of shapes:
//   - unix seconds / milliseconds (number)
//   - ISO-8601 string
//   - a relative "seconds from now" value
function resetFromAbsolute(value: unknown): number | undefined {
  const num = numberValue(value);
  if (num !== undefined) {
    // Heuristic: < 10^12 is seconds, otherwise milliseconds.
    return num < 1_000_000_000_000 ? num * 1000 : num;
  }
  const str = stringValue(value);
  if (str) {
    const parsed = Date.parse(str);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function resetFromRelativeSeconds(value: unknown): number | undefined {
  const secs = numberValue(value);
  return secs !== undefined ? Date.now() + secs * 1000 : undefined;
}

function resolveResetAt(...sources: Array<Record<string, unknown> | undefined>): number | undefined {
  for (const source of sources) {
    if (!source) continue;
    const absolute =
      resetFromAbsolute(source.reset_time) ??
      resetFromAbsolute(source.resets_at) ??
      resetFromAbsolute(source.reset_at) ??
      resetFromAbsolute(source.window_reset_at) ??
      resetFromAbsolute(source.window_end);
    if (absolute !== undefined) return absolute;

    const relative =
      resetFromRelativeSeconds(source.resets_in_seconds) ??
      resetFromRelativeSeconds(source.reset_in_seconds) ??
      resetFromRelativeSeconds(source.seconds_until_reset) ??
      resetFromRelativeSeconds(source.window_remaining_seconds);
    if (relative !== undefined) return relative;
  }
  return undefined;
}

async function fetchClaudeUsage(auth: AuthCredentials): Promise<PlanUsage | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(CLAUDE_USAGE_ENDPOINT, {
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        accept: "application/json",
        "user-agent": "pi-statusbar",
      },
    });
    if (response.status === 401 && attempt === 0 && auth.refreshToken) {
      auth = await refreshAuth(auth);
      continue;
    }
    if (!response.ok) return undefined;
    const obj = objectValue(await response.json());
    const fiveHour = objectValue(obj?.five_hour);
    const util = numberValue(fiveHour?.utilization);
    if (util === undefined) return undefined;
    const resetsAtMs = resolveResetAt(fiveHour);
    return { usedPercent: clampPercent(util), fetchedAt: Date.now(), resetsAtMs };
  }
  return undefined;
}

async function fetchCodexUsage(auth: AuthCredentials): Promise<PlanUsage | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(CODEX_USAGE_ENDPOINT, {
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        accept: "application/json",
        "user-agent": "pi-statusbar",
        ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
      },
    });
    if ((response.status === 401 || response.status === 403) && attempt === 0 && auth.refreshToken) {
      auth = await refreshAuth(auth);
      continue;
    }
    if (!response.ok) return undefined;
    const obj = objectValue(await response.json());
    const rateLimit = objectValue(obj?.rate_limit);
    const primary = objectValue(rateLimit?.primary_window);
    const used =
      numberValue(primary?.used_percent) ??
      numberValue(rateLimit?.used_percent) ??
      numberValue(obj?.used_percent);
    if (used === undefined) return undefined;
    const resetsAtMs = resolveResetAt(primary, rateLimit, obj);
    return { usedPercent: clampPercent(used), fetchedAt: Date.now(), resetsAtMs };
  }
  return undefined;
}

function providerForModel(ctx: ExtensionContext): ProviderId | undefined {
  const id = `${ctx.model?.provider ?? ""} ${ctx.model?.id ?? ""} ${ctx.model?.name ?? ""}`.toLowerCase();
  if (/claude|anthropic|sonnet|opus|haiku/.test(id)) return "anthropic";
  if (/openai|codex|chatgpt|gpt|(^|[^a-z])o[134]([^a-z]|$)/.test(id)) return "openai-codex";
  return undefined;
}

async function readUsageCache(provider: ProviderId): Promise<PlanUsage | undefined> {
  try {
    const parsed = JSON.parse(await readFile(USAGE_CACHE_PATH, "utf8")) as unknown;
    const obj = objectValue(parsed);
    const entry = objectValue(obj?.[provider]);
    const usedPercent = numberValue(entry?.usedPercent);
    const fetchedAt = numberValue(entry?.fetchedAt);
    if (usedPercent === undefined || fetchedAt === undefined) return undefined;
    return { usedPercent, fetchedAt, resetsAtMs: numberValue(entry?.resetsAtMs) };
  } catch {
    return undefined;
  }
}

async function writeUsageCache(provider: ProviderId, usage: PlanUsage): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(USAGE_CACHE_PATH, "utf8")) as unknown;
    existing = objectValue(parsed) ?? {};
  } catch {
    /* start fresh */
  }
  existing[provider] = usage;
  await mkdir(dirname(USAGE_CACHE_PATH), { recursive: true });
  const tmp = `${USAGE_CACHE_PATH}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, USAGE_CACHE_PATH);
}

async function fetchPlanUsage(provider: ProviderId): Promise<PlanUsage | undefined> {
  const cached = await readUsageCache(provider);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  const auth = await resolveAuth(provider);
  if (!auth) return undefined;
  const fresh = await (provider === "anthropic" ? fetchClaudeUsage(auth) : fetchCodexUsage(auth));
  if (fresh) await writeUsageCache(provider, fresh).catch(() => undefined);
  return fresh ?? cached;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const SEP = " • ";
const BAR_WIDTH = 10;
const BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

function progressBar(usedPercent: number): { filled: string; empty: string; label: string } {
  const ratio = clampPercent(usedPercent) / 100;
  const exact = ratio * BAR_WIDTH;
  const full = Math.floor(exact);
  const remainder = exact - full;
  let filled = "█".repeat(full);
  let cells = full;
  if (cells < BAR_WIDTH && remainder > 0) {
    filled += BLOCKS[Math.round(remainder * 8)] || "";
    cells += 1;
  }
  const empty = "░".repeat(Math.max(0, BAR_WIDTH - cells));
  return { filled, empty, label: `${Math.round(usedPercent)}%` };
}

function severityColor(usedPercent: number): "success" | "warning" | "error" {
  if (usedPercent >= 90) return "error";
  if (usedPercent >= 70) return "warning";
  return "success";
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

// Compact relative time until reset, e.g. "2h13m", "45m", "30s".
function formatReset(resetsAtMs: number | undefined): string {
  if (resetsAtMs === undefined) return "";
  const deltaMs = resetsAtMs - Date.now();
  if (deltaMs <= 0) return "now";
  const totalMin = Math.floor(deltaMs / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return `${hours}h${mins.toString().padStart(2, "0")}m`;
  if (totalMin > 0) return `${totalMin}m`;
  return `${Math.max(1, Math.floor(deltaMs / 1000))}s`;
}

function formatThinking(level: string): string {
  if (!level || level === "off") return "";
  return level;
}

export default function (pi: ExtensionAPI) {
  function install(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme) => {
      let usage: PlanUsage | undefined;
      let provider: ProviderId | undefined = providerForModel(ctx);
      let disposed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const refresh = async () => {
        if (disposed) return;
        provider = providerForModel(ctx);
        if (!provider) {
          usage = undefined;
          tui.requestRender();
          return;
        }
        // File cache TTL is checked inside fetchPlanUsage; no need to skip here.
        try {
          const next = await fetchPlanUsage(provider);
          if (disposed) return;
          if (next) {
            usage = next;
            tui.requestRender();
          }
        } catch {
          /* keep previous value */
        }
      };

      const schedule = () => {
        if (disposed) return;
        timer = setTimeout(() => void refresh().finally(schedule), REFRESH_MS);
      };

      void refresh();
      schedule();

      return {
        invalidate() {},
        dispose() {
          disposed = true;
          if (timer) clearTimeout(timer);
        },
        render(width: number): string[] {
          if (width <= 0) return [""];

          const dir = basename(ctx.cwd) || ctx.cwd;
          const providerName = ctx.model?.provider ?? "";
          const modelId = ctx.model?.id || ctx.model?.name || "model";
          const modelText = providerName ? `${providerName}/${modelId}` : modelId;

          const thinking = formatThinking(pi.getThinkingLevel());

          const contextUsage = ctx.getContextUsage();
          const totalTokens = Math.max(
            1,
            Math.floor(
              Number(contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 200_000),
            ),
          );
          const usedTokens = Math.max(
            0,
            Math.floor(Number(contextUsage?.tokens ?? 0)),
          );
          const ctxPercent = clampPercent(
            Number.isFinite(Number(contextUsage?.percent))
              ? Number(contextUsage?.percent)
              : (usedTokens * 100) / totalTokens,
          );

          const parts: string[] = [];

          // directory
          parts.push(theme.fg("dim", dir));

          // provider/model
          parts.push(theme.fg("dim", modelText));

          // thinking level
          if (thinking) parts.push(theme.fg("dim", thinking));

          // context usage bar / total
          const ctxBar = progressBar(ctxPercent);
          const ctxColor = severityColor(ctxPercent);
          parts.push(
            theme.fg(ctxColor, ctxBar.filled) +
              theme.fg("dim", ctxBar.empty) +
              theme.fg("dim", ` ${formatTokens(usedTokens)}/${formatTokens(totalTokens)}`),
          );

          // plan usage bar
          if (usage) {
            const planBar = progressBar(usage.usedPercent);
            const planColor = severityColor(usage.usedPercent);
            const reset = formatReset(usage.resetsAtMs);
            parts.push(
              theme.fg("dim", "plan ") +
                theme.fg(planColor, planBar.filled) +
                theme.fg("dim", planBar.empty) +
                theme.fg("dim", ` ${planBar.label}`) +
                (reset ? theme.fg("dim", ` (resets ${reset})`) : ""),
            );
          }

          const line = parts.join(theme.fg("dim", SEP));
          return [line];
        },
      };
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    install(ctx);
  });

  pi.on("after_provider_response", async (_event, ctx) => {
    // Opportunistically refresh on activity by letting the next scheduled
    // poll pick it up; the footer re-renders on its own cadence.
    void ctx;
  });
}
