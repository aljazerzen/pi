/**
 * Delegate Tool - Spawn a sub-agent with isolated context.
 *
 * The sub-agent runs with the same model and thinking level as the parent
 * session. Use this to offload work that would otherwise pollute the main
 * conversation's context window.
 *
 * Implementation: spawn a fresh `pi` subprocess in JSON print mode, passing
 * through model, thinking level, and active tools. Read the JSONL event
 * stream, accumulate messages, and emit a formatted view of all intermediate
 * tool calls, tool results, and assistant text alongside the final answer.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

const SUBAGENT_SYSTEM_PROMPT = `You are a sub-agent invoked from a parent pi session to handle a single delegated task in an isolated context window.

Rules:
- Work autonomously. Do not ask clarifying questions; make reasonable assumptions.
- Return only the final result. Do not narrate intermediate steps or tool calls.
- Be concise. The parent session will read your output verbatim.`;

interface SingleResult {
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	/** "provider/id" of the sub-agent model — used to label the cost footer. */
	model?: string;
}

/** Token + cost totals rolled up across every assistant turn. */
interface UsageStats {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Cost in dollars, summed across turns. */
	cost: number;
	/** Last reported context size (totalTokens from the most recent turn). */
	contextTokens: number;
}

function aggregateUsage(messages: Message[]): UsageStats {
	const stats: UsageStats = {
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
	};
	for (const msg of messages) {
		if (msg.role !== "assistant" || !msg.usage) continue;
		stats.turns++;
		stats.input += msg.usage.input || 0;
		stats.output += msg.usage.output || 0;
		stats.cacheRead += msg.usage.cacheRead || 0;
		stats.cacheWrite += msg.usage.cacheWrite || 0;
		stats.cost += msg.usage.cost?.total || 0;
		// totalTokens is the running context size at end-of-turn; the last
		// value is what the parent cares about for budget tracking.
		if (typeof msg.usage.totalTokens === "number") {
			stats.contextTokens = msg.usage.totalTokens;
		}
	}
	return stats;
}

function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Format a usage-stats line in the same shape upstream's subagent extension
 * uses: "↑Nk ↓Nk RNk WNk $N.NNNN ctx:Nk model". Used for the cost footer.
 */
function formatUsageStats(stats: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (stats.turns) parts.push(`${stats.turns} turn${stats.turns > 1 ? "s" : ""}`);
	if (stats.input) parts.push(`↑${formatTokenCount(stats.input)}`);
	if (stats.output) parts.push(`↓${formatTokenCount(stats.output)}`);
	if (stats.cacheRead) parts.push(`R${formatTokenCount(stats.cacheRead)}`);
	if (stats.cacheWrite) parts.push(`W${formatTokenCount(stats.cacheWrite)}`);
	if (stats.cost) parts.push(`$${stats.cost.toFixed(4)}`);
	if (stats.contextTokens > 0) parts.push(`ctx:${formatTokenCount(stats.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

// Display limits for the streamed view. One line per message — assistant
// text is whitespace-collapsed, tool results are flattened to their first
// non-empty line plus a size hint when the original was multi-line.
const MAX_TEXT_LINE_CHARS = 200;
const MAX_RESULT_LINE_CHARS = 100;
const RESULT_SIZE_THRESHOLD = 200;

/**
 * Resolve how to invoke pi as a subprocess.
 *
 * Mirrors the helper from upstream's subagent extension: if we're being run
 * from a real script file (Node.js / tsx), exec the current script directly;
 * if the runtime already is `pi` (or a bun/node binary), just exec `pi` from
 * PATH. This makes the extension work both in dev (npx/bun) and when
 * installed (nix profile, npm global).
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

async function writePromptToTempFile(content: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-delegate-"));
	const filePath = path.join(dir, "system-prompt.md");
	await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

function getFinalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function truncateOneline(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * Format a tool call as a one-liner in the TUI. All text is muted gray per
 * user preference — single-color throughout for visual consistency.
 */
function formatToolCallThemed(name: string, args: Record<string, unknown>, theme: Theme): string {
	const m = (s: string) => theme.fg("muted", s);
	const bar = m("▐");
	switch (name) {
		case "bash": {
			const cmd = String(args.command ?? "...");
			return `${bar} ${m("bash $ ")}${m(truncateOneline(cmd.replace(/\s+/g, " ").trim(), 120))}`;
		}
		case "read":
			return `${bar} ${m("read ")}${m(String(args.file_path ?? args.path ?? "..."))}`;
		case "write": {
			const p = String(args.file_path ?? args.path ?? "...");
			const content = String(args.content ?? "");
			const lines = content ? content.split("\n").length : 0;
			const tail = lines > 1 ? m(` (${lines} lines)`) : "";
			return `${bar} ${m("write ")}${m(p)}${tail}`;
		}
		case "edit":
			return `${bar} ${m("edit ")}${m(String(args.file_path ?? args.path ?? "..."))}`;
		case "grep":
			return `${bar} ${m("grep ")}${m(`/${String(args.pattern ?? "")}/`)}${m(` in ${String(args.path ?? ".")}`)}`;
		case "find":
			return `${bar} ${m("find ")}${m(String(args.pattern ?? "*"))}${m(` in ${String(args.path ?? ".")}`)}`;
		case "ls":
			return `${bar} ${m("ls ")}${m(String(args.path ?? "."))}`;
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 80 ? argsStr.slice(0, 80) + "…" : argsStr;
			return `${bar} ${m(name)} ${m(preview)}`;
		}
	}
}

/**
 * Format a tool result as a single indented line: `  result: <summary>`.
 * The body is the first non-empty line of the result, with a `(NB)` size
 * hint appended when the original result was multi-line or longer than the
 * truncation width. Empty results render as `  result: (empty)`.
 */
function formatToolResultThemed(msg: Message, theme: Theme): string {
	if (msg.role !== "toolResult") return "";
	const m = (s: string) => theme.fg("muted", s);
	const textParts = msg.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text);
	const text = textParts.join("\n").trim();
	if (!text) return m("  result: (empty)");

	const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
	const totalSize = text.length;
	const showSize = text.includes("\n") || totalSize > RESULT_SIZE_THRESHOLD;
	const body = truncateOneline(firstLine, MAX_RESULT_LINE_CHARS);
	const sizeHint = showSize ? m(` (${totalSize}B)`) : "";

	return `${m("  result:")} ${m(body)}${sizeHint}`;
}

/**
 * Render the full message history as a chronological stream where each
 * observable event is exactly one line:
 *   - assistant text     → `"<one-line, quoted>"`           (muted)
 *   - tool call          → `→ <name> <args>`                (muted)
 *   - tool result        → `  result: <one-line>`           (muted)
 *
 * Blocks are joined by single newlines so a tool call and its result sit
 * on consecutive lines and read as a pair. Used by `renderResult`.
 */
function formatStreamThemed(messages: Message[], theme: Theme): string[] {
	const m = (s: string) => theme.fg("muted", s);
	const blocks: string[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "thinking") continue;
				if (part.type === "text") {
					// Collapse all whitespace (incl. newlines) into single spaces
					// so multi-paragraph agent commentary fits on one line.
					const text = part.text.trim().replace(/\s+/g, " ");
					if (text) blocks.push(m(`"${truncateOneline(text, MAX_TEXT_LINE_CHARS)}"`));
				} else if (part.type === "toolCall") {
					blocks.push(formatToolCallThemed(part.name, part.arguments as Record<string, unknown>, theme));
				}
			}
		} else if (msg.role === "toolResult") {
			blocks.push(formatToolResultThemed(msg, theme));
		}
	}
	return blocks;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate a task to a sub-agent with isolated context.",
			"The sub-agent uses the same model and thinking level as the parent session,",
			"and inherits the parent's active tools (minus delegate itself).",
			"Use this to offload work that would otherwise pollute the main context window.",
		].join(" "),
		parameters: Type.Object({
			task: Type.String({ description: "Task description to delegate to the sub-agent" }),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<SingleResult>> {
			if (!ctx.model) {
				return {
					content: [{ type: "text", text: "No model is selected in the parent session. Select a model before delegating." }],
					isError: true,
					details: { task: params.task, exitCode: 1, messages: [], stderr: "no parent model" },
				};
			}

			// Inherit parent's active tools, but never recurse: dropping `delegate`
			// (and any other names that aren't useful to a sub-agent) keeps the
			// child focused on its task.
			const parentTools = pi.getActiveTools().filter((name) => name !== "delegate");

			const args: string[] = [
				"--mode", "json",
				"-p",
				"--no-session",
				"--model", `${ctx.model.provider}/${ctx.model.id}`,
				"--thinking", pi.getThinkingLevel(),
				"--tools", parentTools.join(","),
			];

			let tmpDir: string | null = null;
			let tmpPrompt: string | null = null;
			const result: SingleResult = {
				task: params.task,
				exitCode: 0,
				messages: [],
				stderr: "",
				model: `${ctx.model.provider}/${ctx.model.id}`,
			};

			const emitUpdate = () => {
				if (onUpdate) {
					// `content` is what the LLM eventually sees (and what pi falls
					// back to when no custom renderer is installed). The rich,
					// themed display is produced by `renderResult` from `details`.
					// During streaming we still put something useful here so the
					// fallback path (non-TUI modes, plugin hosts) shows progress.
					const latestText = getFinalText(result.messages);
					onUpdate({
						content: [{ type: "text", text: latestText || "(sub-agent running…)" }],
						details: { ...result, messages: [...result.messages] },
					});
				}
			};

			try {
				const tmp = await writePromptToTempFile(SUBAGENT_SYSTEM_PROMPT);
				tmpDir = tmp.dir;
				tmpPrompt = tmp.filePath;
				args.push("--append-system-prompt", tmpPrompt);
				args.push(params.task);

				result.exitCode = await new Promise<number>((resolve) => {
					const invocation = getPiInvocation(args);
					const proc = spawn(invocation.command, invocation.args, {
						cwd: ctx.cwd,
						shell: false,
						stdio: ["ignore", "pipe", "pipe"],
					});
					let buffer = "";

					const processLine = (line: string) => {
						if (!line.trim()) return;
						let event: any;
						try {
							event = JSON.parse(line);
						} catch {
							return;
						}
						if (event.type === "message_end" && event.message) {
							result.messages.push(event.message as Message);
							emitUpdate();
						} else if (event.type === "tool_result_end" && event.message) {
							// Append after the assistant message that issued the call so
							// chronological order in `messages` matches what we render.
							result.messages.push(event.message as Message);
							emitUpdate();
						}
					};

					proc.stdout.on("data", (data) => {
						buffer += data.toString();
						const lines = buffer.split("\n");
						buffer = lines.pop() || "";
						for (const line of lines) processLine(line);
					});
					proc.stderr.on("data", (data) => {
						result.stderr += data.toString();
					});
					proc.on("close", (code) => {
						if (buffer.trim()) processLine(buffer);
						resolve(code ?? 0);
					});
					proc.on("error", () => resolve(1));

					if (signal) {
						const kill = () => {
							proc.kill("SIGTERM");
							setTimeout(() => {
								if (!proc.killed) proc.kill("SIGKILL");
							}, 5000);
						};
						if (signal.aborted) kill();
						else signal.addEventListener("abort", kill, { once: true });
					}
				});

				const finalText = getFinalText(result.messages);

				if (result.exitCode !== 0) {
					// Keep the LLM-facing content minimal: just the error summary.
					// The full stream + stderr are in `details` for the user.
					const errMsg = result.stderr.trim()
						? `Sub-agent failed (exit ${result.exitCode}): ${result.stderr.trim().split("\n")[0]}`
						: `Sub-agent failed (exit ${result.exitCode}) with no output.`;
					return {
						content: [{ type: "text", text: errMsg }],
						isError: true,
						details: result,
					};
				}

				// Success path: LLM gets just the final assistant text. The rich
				// stream is in `details` and rendered by `renderResult`.
				return {
					content: [{ type: "text", text: finalText || "(sub-agent produced no final text)" }],
					details: result,
				};
			} finally {
				if (tmpPrompt) try { fs.unlinkSync(tmpPrompt); } catch { /* ignore */ }
				if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
			}
		},

		renderCall(args, theme, _context) {
			// Print the full prompt verbatim so the user can audit what the
			// sub-agent was asked to do. pi's Text component handles wrapping
			// for long prompts.
			return new Text(`${theme.fg("muted", "delegate")} ${theme.fg("muted", args.task)}`);
		},

		renderResult(result, { isPartial }, theme, _context) {
			const details = result.details;
			const m = (s: string) => theme.fg("muted", s);

			// Status header — all muted per user preference.
			let header: string;
			if (result.isError) {
				header = m(`✗ sub-agent failed (exit ${details?.exitCode ?? "?"})`);
			} else if (isPartial) {
				header = m("⏳ sub-agent running…");
			} else {
				header = m("✓ sub-agent completed");
			}

			// Stderr (only shown for errors)
			const stderrBlock = result.isError && details?.stderr.trim()
				? `\n${m(details.stderr.trim())}`
				: "";

			// Stream of intermediate tool calls + replies + agent text. Single
			// newline between blocks so a call and its result read as a pair.
			// No blank line separator — the renderResult is one tight block.
			const streamBlocks = details ? formatStreamThemed(details.messages, theme) : [];
			const streamSection = streamBlocks.length
				? `\n${streamBlocks.join("\n")}`
				: "";

			// Final answer — only shown once the run is complete.
			let finalBlock = "";
			if (details && !isPartial && !result.isError) {
				const finalText = getFinalText(details.messages);
				if (finalText) {
					finalBlock = `\n${m("———")}\n${m("Final answer:")}\n${m(finalText)}`;
				}
			}

			// Session cost footer — token totals + estimated cost, aggregated
			// from every assistant turn's `usage`. Shown once the run completes
			// (or has progressed enough to have at least one turn).
			let costBlock = "";
			if (details && !isPartial) {
				const stats = aggregateUsage(details.messages);
				const line = formatUsageStats(stats, details.model);
				if (line) costBlock = `\n${m(line)}`;
			}

			return new Text(`${header}${stderrBlock}${streamSection}${finalBlock}${costBlock}`);
		},
	});
}
