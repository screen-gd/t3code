import type { CloudTaskChatEntry, HopliteCloudThreadStatus } from "@t3tools/contracts";

import type { AgentKeys, CommandResult } from "./CloudSandboxProviders.ts";
import type { HopliteRunStatus } from "./HopliteCloudService.ts";

const STATE_DIR = "$HOME/.t3-task";
const MAX_REPLY_LENGTH = 20_000;
const MAX_CHAT_TURNS = 20;
const MAX_CHAT_TURN_BYTES = 500_000;
const ERR_MARKER = "---t3-task-err---";
// Older sandboxes keep their last turn directly in STATE_DIR.
const CURRENT_STATE = `turn=$(cat "${STATE_DIR}/turn" 2>/dev/null || true); state="${STATE_DIR}/runs/$turn"; [ -d "$state" ] || state="${STATE_DIR}"`;

/**
 * Works the queue one turn at a time in the background, so a follow-up can land
 * while the last turn still runs. Its fd-9 flock is the same lock the enqueue side
 * takes, which keeps the queue, the turn counter and `runner.alive` consistent.
 */
const RUNNER_SCRIPT = `\
STATE_DIR="${STATE_DIR}"
cd "$HOME/work" || exit 1
while :; do
  turn=$(
    exec 9>"$STATE_DIR/lock"
    flock 9
    item=$(ls "$STATE_DIR/queue" 2>/dev/null | sed -n 's/\\.prompt$//p' | sort -n | head -1)
    if [ -z "$item" ]; then
      rm -f "$STATE_DIR/runner.alive"
      exit 0
    fi
    next=$(( $(cat "$STATE_DIR/turn" 2>/dev/null || echo 0) + 1 ))
    echo "$next" > "$STATE_DIR/turn"
    mkdir -p "$STATE_DIR/runs/$next"
    mv "$STATE_DIR/queue/$item.prompt" "$STATE_DIR/runs/$next/prompt"
    mv "$STATE_DIR/queue/$item.model" "$STATE_DIR/runs/$next/model" 2>/dev/null || true
    echo "$next"
  )
  [ -z "$turn" ] && break
  state="$STATE_DIR/runs/$turn"
  args=()
  [ "$turn" -gt 1 ] && args+=(-c)
  [ -s "$state/model" ] && args+=(--model "$(cat "$state/model")")
  T3_TASK_PROMPT="$(cat "$state/prompt")"
  export T3_TASK_PROMPT
  npx -y @anthropic-ai/claude-code -p "$T3_TASK_PROMPT" "\${args[@]}" --dangerously-skip-permissions --output-format stream-json --verbose > "$state/out.jsonl" 2> "$state/err.log"
  code=$?
  (
    exec 9>"$STATE_DIR/lock"
    flock 9
    echo "$code" > "$state/exit"
  )
done
`;

/**
 * What runs inside the sandbox to hand the agent a message: prompt, repo, model and
 * keys arrive as environment variables, never in its text. Under the runner's lock it
 * either starts the runner and names the turn its message gets, or queues and reports `queued`.
 */
export const agentTurnScript = (input: { readonly first: boolean }) =>
  [
    "set -e",
    `mkdir -p "${STATE_DIR}/queue"`,
    `git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`,
    ...(input.first
      ? [
          'if [ -n "$T3_TASK_REPO" ] && [ ! -d "$HOME/work/.git" ]; then git clone "https://github.com/$T3_TASK_REPO.git" "$HOME/work"; fi',
        ]
      : []),
    'mkdir -p "$HOME/work"',
    // mv keeps a runner that is already inside the old file on its own copy.
    `cat > "${STATE_DIR}/runner.sh.tmp" <<'T3_RUNNER'`,
    RUNNER_SCRIPT,
    "T3_RUNNER",
    `mv -f "${STATE_DIR}/runner.sh.tmp" "${STATE_DIR}/runner.sh"`,
    `chmod +x "${STATE_DIR}/runner.sh"`,
    "(",
    `  exec 9>"${STATE_DIR}/lock"`,
    "  flock 9",
    `  seq=$(( $(cat "${STATE_DIR}/seq" 2>/dev/null || echo 0) + 1 ))`,
    `  echo "$seq" > "${STATE_DIR}/seq"`,
    "  item=$(printf '%06d' \"$seq\")",
    `  printf '%s' "$T3_TASK_PROMPT" > "${STATE_DIR}/queue/$item.prompt"`,
    `  if [ -n "\${T3_TASK_MODEL:-}" ]; then printf '%s' "$T3_TASK_MODEL" > "${STATE_DIR}/queue/$item.model"; fi`,
    `  if [ -f "${STATE_DIR}/runner.alive" ] && kill -0 "$(cat "${STATE_DIR}/runner.pid" 2>/dev/null)" 2>/dev/null; then`,
    '    echo "queued"',
    "  else",
    `    touch "${STATE_DIR}/runner.alive"`,
    `    setsid nohup bash "${STATE_DIR}/runner.sh" </dev/null >/dev/null 2>&1 9>&- &`,
    `    echo $! > "${STATE_DIR}/runner.pid"`,
    `    echo "turn=$(( $(cat "${STATE_DIR}/turn" 2>/dev/null || echo 0) + 1 ))"`,
    "  fi",
    ")",
  ].join("\n");

/** The run id of the turn agentTurnScript started; null while its message queued behind one. */
export const startedRunId = (result: CommandResult) => {
  const turn = [...result.output.matchAll(/^turn=(\d+)$/gm)].at(-1)?.[1];
  return turn === undefined ? null : `turn-${turn}`;
};

export const agentTurnEnv = (
  keys: AgentKeys,
  prompt: string,
  repo: string | undefined,
  model?: string,
): Record<string, string> => ({
  [keys.claude.variable]: keys.claude.value,
  ...(keys.githubToken === undefined
    ? {}
    : { GH_TOKEN: keys.githubToken, GITHUB_TOKEN: keys.githubToken }),
  T3_TASK_PROMPT: prompt,
  ...(repo === undefined ? {} : { T3_TASK_REPO: repo }),
  ...(model === undefined ? {} : { T3_TASK_MODEL: model }),
});

// Whole lines from the start of the reply and the end of the log, so no key is cut in two.
export const readTurnScript = (turn?: number) =>
  [
    ...(turn === undefined
      ? [CURRENT_STATE]
      : [
          `turn=${turn}; state="${STATE_DIR}/runs/$turn"`,
          `if [ ! -d "$state" ] && [ "$(cat "${STATE_DIR}/turn" 2>/dev/null)" = "$turn" ]; then state="${STATE_DIR}"; fi`,
        ]),
    'echo "turn=$turn"',
    'echo "exit=$(cat "$state/exit" 2>/dev/null)"',
    'echo "---"',
    'head -c 200000 "$state/out.json" 2>/dev/null || true',
    'size=$(wc -c < "$state/out.jsonl" 2>/dev/null || echo 0)',
    // A cut can land mid-line; the first tail line is dropped so every line parses whole.
    'if [ "$size" -gt 200000 ]; then tail -c 200000 "$state/out.jsonl" | tail -n +2; else cat "$state/out.jsonl" 2>/dev/null || true; fi',
    `echo; echo "${ERR_MARKER}"`,
    'tail -n 40 "$state/err.log" 2>/dev/null || true',
  ].join("\n");

/** The task's chat: each recent turn's prompt, streamed output and exit, then whether it still runs. */
export const readChatScript = () =>
  [
    `for state in $(ls -d "${STATE_DIR}"/runs/*/ 2>/dev/null | sort -V | tail -${MAX_CHAT_TURNS.toString()}); do`,
    '  echo "---t3-chat-turn $(basename "$state")---"',
    '  echo "---t3-chat-prompt---"',
    '  cat "$state/prompt" 2>/dev/null; echo',
    '  echo "---t3-chat-jsonl---"',
    '  size=$(wc -c < "$state/out.jsonl" 2>/dev/null || echo 0)',
    `  if [ "$size" -gt ${MAX_CHAT_TURN_BYTES.toString()} ]; then tail -c ${MAX_CHAT_TURN_BYTES.toString()} "$state/out.jsonl" | tail -n +2; else cat "$state/out.jsonl" 2>/dev/null; fi; echo`,
    '  echo "---t3-chat-result---"',
    '  cat "$state/out.json" 2>/dev/null; echo',
    '  echo "---t3-chat-exit---"',
    '  cat "$state/exit" 2>/dev/null; echo',
    "done",
    'echo "---t3-chat-running---"',
    `[ -f "${STATE_DIR}/runner.alive" ] && echo 1 || echo 0`,
  ].join("\n");

export const chatIsRunning = (output: string) => /---t3-chat-running---\s*\n1\s*$/.test(output);

// setsid makes the runner's pid its process group, so this stops the runner, its agent and the queue.
export const STOP_SCRIPT = `${CURRENT_STATE}; pid=$(cat "${STATE_DIR}/runner.pid" 2>/dev/null); [ -z "$pid" ] && pid=$(cat "$state/pid" 2>/dev/null); kill -- -$pid 2>/dev/null || true; rm -f "${STATE_DIR}"/queue/*.prompt "${STATE_DIR}"/queue/*.model "${STATE_DIR}/runner.alive"; [ -f "$state/exit" ] || echo 130 > "$state/exit"`;

const PULL_REQUEST = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** Keys must never come back in a task's reply, even when the agent prints them. */
export const redact = (text: string, keys: ReadonlyArray<string | undefined>) =>
  keys.reduce<string>(
    (current, key) =>
      key === undefined || key.length < 8 ? current : current.replaceAll(key, "[redacted]"),
    text,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseJsonLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

// One content block's text, as Claude Code's stream-json assistant messages carry it.
const blockText = (block: unknown) =>
  isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : null;

const messageText = (event: Record<string, unknown>) => {
  const content = isRecord(event.message) ? event.message.content : undefined;
  if (!Array.isArray(content)) return null;
  const text = content
    .flatMap((block) => {
      const text = blockText(block);
      return text === null ? [] : [text];
    })
    .join("");
  return text === "" ? null : text;
};

const toolTitle = (block: Record<string, unknown>) => {
  const name = typeof block.name === "string" ? block.name : "Tool";
  const input = isRecord(block.input) ? block.input : {};
  const detail =
    typeof input.command === "string"
      ? input.command
      : typeof input.file_path === "string"
        ? input.file_path
        : typeof input.pattern === "string"
          ? input.pattern
          : null;
  return detail === null ? name : `${name}: ${detail.split("\n", 1)[0]!.slice(0, 80)}`;
};

/**
 * The chat readChatScript prints, as entries: each turn's prompt, assistant text and
 * tool calls. A tool stays in_progress until its tool_result, or failed when the turn
 * exits without one. Turns from before stream-json carry only their result.
 */
export const parseChat = (output: string): Array<CloudTaskChatEntry> => {
  const turns: Array<{
    readonly turn: number;
    prompt: string;
    jsonl: string;
    result: string;
    exit: string;
  }> = [];
  let current: (typeof turns)[number] | undefined;
  let field: "prompt" | "jsonl" | "result" | "exit" | undefined;
  for (const line of output.split("\n")) {
    const turnStart = /^---t3-chat-turn (\d+)---$/.exec(line);
    if (turnStart !== null) {
      current = { turn: Number(turnStart[1]), prompt: "", jsonl: "", result: "", exit: "" };
      turns.push(current);
      field = undefined;
      continue;
    }
    const fieldStart = /^---t3-chat-(prompt|jsonl|result|exit)---$/.exec(line);
    if (fieldStart !== null) {
      field = fieldStart[1] as typeof field;
      continue;
    }
    if (line === "---t3-chat-running---") break;
    if (current !== undefined && field !== undefined) current[field] += `${line}\n`;
  }
  const entries: Array<CloudTaskChatEntry> = [];
  for (const turn of turns.sort((a, b) => a.turn - b.turn)) {
    const prompt = turn.prompt.replace(/\n$/, "");
    if (prompt !== "")
      entries.push({ _tag: "message", id: `turn-${turn.turn}-user`, role: "user", text: prompt });
    const tools = new Map<string, number>();
    const pending = new Set<number>();
    let index = 0;
    if (turn.jsonl.trim() !== "") {
      for (const raw of turn.jsonl.split("\n")) {
        const line = raw.trim();
        if (!line.startsWith("{")) continue;
        const event = parseJsonLine(line);
        if (!isRecord(event)) continue;
        const content = isRecord(event.message) ? event.message.content : undefined;
        if (event.type === "assistant" && Array.isArray(content)) {
          for (const block of content) {
            if (!isRecord(block)) continue;
            const text = blockText(block);
            if (text !== null && text !== "") {
              entries.push({
                _tag: "message",
                id: `turn-${turn.turn}-${(index += 1)}`,
                role: "assistant",
                text,
              });
            } else if (block.type === "tool_use" && typeof block.id === "string") {
              tools.set(block.id, entries.length);
              pending.add(entries.length);
              entries.push({
                _tag: "tool",
                id: block.id,
                title: toolTitle(block),
                status: "in_progress",
              });
            }
          }
        } else if (event.type === "user" && Array.isArray(content)) {
          for (const block of content) {
            if (!isRecord(block) || block.type !== "tool_result") continue;
            const at =
              typeof block.tool_use_id === "string" ? tools.get(block.tool_use_id) : undefined;
            if (at === undefined) continue;
            const entry = entries[at];
            if (entry?._tag !== "tool") continue;
            entries[at] = { ...entry, status: block.is_error === true ? "failed" : "completed" };
            pending.delete(at);
          }
        }
      }
    } else {
      const parsed = parseJsonLine(turn.result.trim());
      if (isRecord(parsed) && typeof parsed.result === "string" && parsed.result !== "")
        entries.push({
          _tag: "message",
          id: `turn-${turn.turn}-${(index += 1)}`,
          role: "assistant",
          text: parsed.result,
        });
    }
    // A turn that exited leaves no tool still working.
    if (turn.exit.trim() !== "") {
      for (const at of pending) {
        const entry = entries[at];
        if (entry?._tag === "tool") entries[at] = { ...entry, status: "failed" };
      }
    }
  }
  return entries;
};

export interface TurnState {
  readonly thread: HopliteCloudThreadStatus;
  readonly run: { readonly id: string; readonly status: HopliteRunStatus };
  readonly latestReply: string | null;
  readonly pullRequestUrl: string | null;
}

/**
 * Reads readTurnScript's output, which must already be redacted: no exit code yet
 * means the agent still runs. Stream-json turns answer with their result line, and
 * with their last assistant text while still running.
 */
export const parseTurn = (result: CommandResult): TurnState => {
  const [header = "", ...rest] = result.output.split("\n---\n");
  const turn = /turn=(\d*)/.exec(header)?.[1] ?? "";
  const exit = /exit=(\d*)/.exec(header)?.[1] ?? "";
  const body = rest.join("\n---\n");
  const markerAt = body.lastIndexOf(ERR_MARKER);
  const out = (markerAt === -1 ? body : body.slice(0, markerAt)).trim();
  const err = markerAt === -1 ? "" : body.slice(markerAt + ERR_MARKER.length).trim();
  let settled: string | undefined;
  let lastAssistant: string | undefined;
  // Legacy out.json is one object with the final result; anything else is stream-json.
  const legacy = parseJsonLine(out);
  if (isRecord(legacy) && typeof legacy.result === "string") {
    settled = legacy.result;
  } else {
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("{")) continue;
      const event = parseJsonLine(line);
      if (!isRecord(event)) continue;
      if (event.type === "result" && typeof event.result === "string") settled = event.result;
      if (event.type === "assistant") {
        const text = messageText(event);
        if (text !== null) lastAssistant = text;
      }
    }
  }
  const reply = settled ?? lastAssistant ?? (out.length > 0 ? out : err.length > 0 ? err : null);
  const pullRequests = body.match(PULL_REQUEST);
  const runId = `turn-${turn === "" ? "0" : turn}`;
  const state =
    turn === ""
      ? { thread: "queued" as const, run: "queued" as const }
      : exit === ""
        ? { thread: "running" as const, run: "running" as const }
        : exit === "0"
          ? { thread: "ready" as const, run: "completed" as const }
          : exit === "130"
            ? { thread: "blocked" as const, run: "cancelled" as const }
            : { thread: "failed" as const, run: "failed" as const };
  return {
    thread: state.thread,
    run: { id: runId, status: state.run },
    latestReply: reply === null ? null : reply.slice(0, MAX_REPLY_LENGTH),
    pullRequestUrl: pullRequests?.at(-1) ?? null,
  };
};
