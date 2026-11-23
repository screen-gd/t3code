// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Digest is effectful; agentTurnEnv builds its environment synchronously.
import * as NodeCrypto from "node:crypto";

import type { CloudTaskChatEntry, HopliteCloudThreadStatus } from "@t3tools/contracts";

import type { AgentKeys, CommandResult } from "./CloudSandboxProviders.ts";
import type { HopliteRunStatus } from "./HopliteCloudService.ts";
import { questionServerSource } from "./CloudSandboxQuestions.ts";

const STATE_DIR = "$HOME/.t3-task";
const MAX_REPLY_LENGTH = 20_000;
const MAX_CHAT_TURNS = 20;
const MAX_CHAT_TURN_BYTES = 500_000;
const ERR_MARKER = "---t3-task-err---";
// Older sandboxes keep their last turn directly in STATE_DIR.
const CURRENT_STATE = `turn=$(cat "${STATE_DIR}/turn" 2>/dev/null || true); state="${STATE_DIR}/runs/$turn"; [ -d "$state" ] || state="${STATE_DIR}"`;

// An advisory kernel lock releases even if acquisition or its holder is killed.
const T3_LOCK = `t3_lock() {
  if ! command -v flock >/dev/null 2>&1; then
    echo "flock is required to run sandbox tasks; use an image with util-linux installed." >&2
    exit 1
  fi
  exec 9>"$STATE_DIR/lock" || exit 1
  flock 9 || exit 1
}`;

/**
 * Sets `live` to 1 only when the recorded runner really runs: its marker exists, its
 * pid is alive, and a readable /proc cmdline still names runner.sh. Else 0.
 */
const RUNNER_LIVE = `live=0
pid=$(cat "$STATE_DIR/runner.pid" 2>/dev/null || true)
if [ -f "$STATE_DIR/runner.alive" ] && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  live=1
  if [ -r "/proc/$pid/cmdline" ] && ! grep -qa runner.sh "/proc/$pid/cmdline"; then live=0; fi
fi`;

/**
 * Works the queue one turn at a time in the background, so a follow-up can land
 * while the last turn still runs. Its t3_lock is the same lock the enqueue side
 * takes, which keeps the queue, the turn counter and `runner.alive` consistent.
 */
const RUNNER_SCRIPT = `\
STATE_DIR="${STATE_DIR}"
cd "$HOME/work" || exit 1
${T3_LOCK}
agent=$(cat "$STATE_DIR/agent" 2>/dev/null || true)
[ -z "$agent" ] && agent=claude
while :; do
  turn=$(
    t3_lock
    item=$(ls "$STATE_DIR/queue" 2>/dev/null | sed -n 's/\\.prompt$//p' | sort -n | head -1)
    if [ -z "$item" ]; then
      rm -f "$STATE_DIR/runner.alive"
      exit 0
    fi
    next=$(( $(cat "$STATE_DIR/turn" 2>/dev/null || echo 0) + 1 ))
    echo "$next" > "$STATE_DIR/turn"
    mkdir -p "$STATE_DIR/runs/$next"
    echo "$item" > "$STATE_DIR/runs/$next/item"
    mv "$STATE_DIR/queue/$item.prompt" "$STATE_DIR/runs/$next/prompt"
    if ! mv "$STATE_DIR/queue/$item.model" "$STATE_DIR/runs/$next/model" 2>/dev/null; then
      cp "$STATE_DIR/runs/$((next - 1))/model" "$STATE_DIR/runs/$next/model" 2>/dev/null || true
    fi
    echo "$next"
  )
  [ -z "$turn" ] && break
  state="$STATE_DIR/runs/$turn"
  args=()
  T3_TASK_PROMPT="$(cat "$state/prompt")"
  export T3_TASK_PROMPT
  if [ "$agent" = "codex" ]; then
    [ -s "$state/model" ] && args+=(-m "$(cat "$state/model")")
    [ "$turn" -gt 1 ] && args+=(resume --last)
    npx -y @openai/codex -c 'mcp_servers.t3_questions.command="node"' -c "mcp_servers.t3_questions.args=['$STATE_DIR/questions.cjs']" -c 'mcp_servers.t3_questions.tool_timeout_sec=86400' exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "\${args[@]}" "$T3_TASK_PROMPT" > "$state/out.jsonl" 2> "$state/err.log"
  else
    [ "$turn" -gt 1 ] && args+=(-c)
    [ -s "$state/model" ] && args+=(--model "$(cat "$state/model")")
    MCP_TOOL_TIMEOUT=2147483647 npx -y @anthropic-ai/claude-code -p "$T3_TASK_PROMPT" "\${args[@]}" --mcp-config "$STATE_DIR/mcp.json" --append-system-prompt 'Use mcp__t3_questions__request_user_input for questions, including choices. The main agent relays them to the user. Wait for its answer. A question printed in chat is not completion.' --dangerously-skip-permissions --output-format stream-json --verbose > "$state/out.jsonl" 2> "$state/err.log"
  fi
  code=$?
  (
    t3_lock
    echo "$code" > "$state/exit"
  )
done
`;

/**
 * What runs inside the sandbox to hand the agent a message: prompt, repo, model and
 * keys arrive as environment variables, never in its text. Under the task lock it
 * either (re)starts the runner and names the turn its message gets, or queues the
 * message and reports `queued`; a live runner on another login refuses it first.
 */
export const agentTurnScript = (input: { readonly first: boolean }) =>
  [
    "set -e",
    `STATE_DIR="${STATE_DIR}"`,
    `mkdir -p "${STATE_DIR}/queue"`,
    `git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`,
    ...(input.first
      ? [
          'if [ -n "$T3_TASK_REPO" ] && [ ! -d "$HOME/work/.git" ]; then git clone "https://github.com/$T3_TASK_REPO.git" "$HOME/work"; fi',
          `if [ ! -f "${STATE_DIR}/agent" ]; then printf '%s' "\${T3_TASK_AGENT:-claude}" > "${STATE_DIR}/agent"; fi`,
        ]
      : []),
    'mkdir -p "$HOME/work"',
    `cat > "${STATE_DIR}/questions.cjs" <<'T3_QUESTIONS'`,
    questionServerSource,
    "T3_QUESTIONS",
    `node -e 'require("node:fs").writeFileSync(process.env.HOME+"/.t3-task/mcp.json",JSON.stringify({mcpServers:{t3_questions:{command:"node",args:[process.env.HOME+"/.t3-task/questions.cjs"]}}}))'`,
    // mv keeps a runner that is already inside the old file on its own copy.
    `cat > "${STATE_DIR}/runner.sh.$$" <<'T3_RUNNER'`,
    RUNNER_SCRIPT,
    "T3_RUNNER",
    `mv -f "${STATE_DIR}/runner.sh.$$" "${STATE_DIR}/runner.sh"`,
    `chmod +x "${STATE_DIR}/runner.sh"`,
    T3_LOCK,
    "(",
    "  t3_lock",
    RUNNER_LIVE.split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    // A live runner on a different login owns the task; refuse before touching seq or queue.
    `  if [ "$live" = 1 ] && [ -f "${STATE_DIR}/runner.key" ] && [ "$(cat "${STATE_DIR}/runner.key" 2>/dev/null)" != "\${T3_TASK_KEY_ID:-}" ]; then`,
    '    echo "---t3-task-login-changed---"',
    "    exit 3",
    "  fi",
    `  if [ "$live" != 1 ]; then`,
    // A dead runner left its turn without an exit: mark it killed and drop what it queued.
    `    turn_now=$(cat "${STATE_DIR}/turn" 2>/dev/null || echo 0)`,
    `    if [ -d "${STATE_DIR}/runs/$turn_now" ] && [ ! -f "${STATE_DIR}/runs/$turn_now/exit" ]; then`,
    `      echo 137 > "${STATE_DIR}/runs/$turn_now/exit"`,
    "    fi",
    `    rm -f "${STATE_DIR}"/queue/*.prompt "${STATE_DIR}"/queue/*.model`,
    // The queue item lands only after the pid exists, so a reader that sees the item
    // sees a live pid; the runner still dequeues it once it takes the lock.
    `    touch "${STATE_DIR}/runner.alive"`,
    `    setsid nohup bash "${STATE_DIR}/runner.sh" </dev/null >/dev/null 2>&1 9>&- &`,
    `    echo $! > "${STATE_DIR}/runner.pid"`,
    `    printf '%s' "\${T3_TASK_KEY_ID:-}" > "${STATE_DIR}/runner.key"`,
    "  fi",
    `  seq=$(( $(cat "${STATE_DIR}/seq" 2>/dev/null || echo 0) + 1 ))`,
    `  echo "$seq" > "${STATE_DIR}/seq"`,
    "  item=$(printf '%06d' \"$seq\")",
    `  printf '%s' "$T3_TASK_PROMPT" > "${STATE_DIR}/queue/$item.prompt"`,
    `  if [ -n "\${T3_TASK_MODEL:-}" ]; then printf '%s' "$T3_TASK_MODEL" > "${STATE_DIR}/queue/$item.model"; fi`,
    `  if [ "$live" = 1 ]; then`,
    `    echo "queued=$seq"`,
    "  else",
    `    echo "turn=$(( $(cat "${STATE_DIR}/turn" 2>/dev/null || echo 0) + 1 ))"`,
    "  fi",
    ")",
  ].join("\n");

/** The run id agentTurnScript reports: `turn-N` for a started turn, `queued-N` for a queued message. */
export const startedRunId = (result: CommandResult) => {
  const turn = [...result.output.matchAll(/^turn=(\d+)$/gm)].at(-1)?.[1];
  if (turn !== undefined) return `turn-${turn}`;
  const queued = [...result.output.matchAll(/^queued=(\d+)$/gm)].at(-1)?.[1];
  return queued === undefined ? null : `queued-${queued}`;
};

// A short fingerprint of the agent credential: a live runner refuses follow-ups
// signed with another login than the one it started on.
const keyId = (variable: string, value: string) =>
  NodeCrypto.createHash("sha256").update(`${variable}\0${value}`).digest("hex").slice(0, 16);

export const agentTurnEnv = (
  keys: AgentKeys,
  prompt: string,
  repo: string | undefined,
  model?: string,
): Record<string, string> => ({
  [keys.agent.variable]: keys.agent.value,
  ...(keys.githubToken === undefined
    ? {}
    : { GH_TOKEN: keys.githubToken, GITHUB_TOKEN: keys.githubToken }),
  T3_TASK_AGENT: keys.agent.name,
  T3_TASK_KEY_ID: keyId(keys.agent.variable, keys.agent.value),
  T3_TASK_PROMPT: prompt,
  ...(repo === undefined ? {} : { T3_TASK_REPO: repo }),
  ...(model === undefined ? {} : { T3_TASK_MODEL: model }),
});

// Whole lines from the start of the reply and the end of the log, so no key is cut in two.
// `{queued: N}` reads the run a queue item became, or says pending/dropped while it waits.
export const readTurnScript = (input?: { readonly turn: number } | { readonly queued: number }) =>
  [
    `STATE_DIR="${STATE_DIR}"`,
    RUNNER_LIVE,
    ...(input === undefined
      ? [CURRENT_STATE]
      : "turn" in input
        ? [
            `turn=${input.turn}; state="${STATE_DIR}/runs/$turn"`,
            `if [ ! -d "$state" ] && [ "$(cat "${STATE_DIR}/turn" 2>/dev/null)" = "$turn" ]; then state="${STATE_DIR}"; fi`,
          ]
        : [
            `item=$(printf '%06d' ${input.queued})`,
            'state=""',
            `find_item() { for dir in "${STATE_DIR}"/runs/*/; do`,
            '  if [ -f "$dir/item" ] && [ "$(cat "$dir/item" 2>/dev/null)" = "$item" ]; then state="${dir%/}"; return; fi',
            "done; }",
            "find_item",
            // The runner writes `item` before it moves the prompt out of the queue, so a
            // second look after the prompt left finds the turn it became.
            `if [ -f "${STATE_DIR}/queue/$item.prompt" ]; then prompt_seen=yes; else prompt_seen=no; fi`,
            'if [ -z "$state" ] && [ "$prompt_seen" = no ]; then find_item; fi',
            'if [ -n "$state" ]; then turn=$(basename "$state"); else turn=""; fi',
          ]),
    'echo "turn=$turn"',
    'echo "live=$live"',
    'echo "exit=$(cat "$state/exit" 2>/dev/null)"',
    ...(input !== undefined && "queued" in input
      ? [
          'if [ -z "$state" ]; then',
          '  if [ "$prompt_seen" = yes ]; then echo "pending=1"; else echo "dropped=1"; fi',
          "fi",
        ]
      : []),
    'echo "---"',
    'head -c 200000 "$state/out.json" 2>/dev/null || true',
    'size=$(wc -c < "$state/out.jsonl" 2>/dev/null || echo 0)',
    // A cut can land mid-line; the first tail line is dropped so every line parses whole.
    'if [ "$size" -gt 200000 ]; then tail -c 200000 "$state/out.jsonl" | tail -n +2; else cat "$state/out.jsonl" 2>/dev/null || true; fi',
    `echo; echo "${ERR_MARKER}"`,
    'tail -n 40 "$state/err.log" 2>/dev/null || true',
  ].join("\n");

/** The task's chat: each recent turn's prompt, streamed output and exit, then whether its runner lives. */
export const readChatScript = () =>
  [
    `STATE_DIR="${STATE_DIR}"`,
    RUNNER_LIVE,
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
    'echo "$live"',
  ].join("\n");

export const chatIsRunning = (output: string) => /---t3-chat-running---\s*\n1\s*$/.test(output);

// setsid makes the runner's pid its process group, so this stops the runner, its agent
// and the queue. The lock means no queued item becomes a turn between the read and the kill.
export const STOP_SCRIPT = [
  `STATE_DIR="${STATE_DIR}"`,
  T3_LOCK,
  "(",
  "  t3_lock",
  `  ${CURRENT_STATE}`,
  `  pid=$(cat "${STATE_DIR}/runner.pid" 2>/dev/null); [ -z "$pid" ] && pid=$(cat "$state/pid" 2>/dev/null); kill -- -$pid 2>/dev/null || true`,
  `  rm -f "${STATE_DIR}"/queue/*.prompt "${STATE_DIR}"/queue/*.model "${STATE_DIR}/runner.alive"`,
  '  [ -f "$state/exit" ] || echo 130 > "$state/exit"',
  ")",
].join("\n");

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

// Codex's stream-json calls work items instead of tool blocks; title each the same way.
const codexToolTitle = (item: Record<string, unknown>) => {
  switch (item.type) {
    case "command_execution":
      return typeof item.command === "string"
        ? `Bash: ${item.command.split("\n", 1)[0]!.slice(0, 80)}`
        : "Bash";
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const first =
        isRecord(changes[0]) && typeof changes[0].path === "string" ? changes[0].path : undefined;
      if (first === undefined) return "Edit";
      return changes.length > 1 ? `Edit: ${first} (+${changes.length - 1} more)` : `Edit: ${first}`;
    }
    case "mcp_tool_call": {
      const server = typeof item.server === "string" ? item.server : "mcp";
      const tool = typeof item.tool === "string" ? item.tool : "call";
      return `${server}.${tool}`;
    }
    case "web_search":
      return typeof item.query === "string" ? `Search: ${item.query}` : "Search";
    default:
      return "Tool";
  }
};

const codexToolStatus = (item: Record<string, unknown>, completed: boolean) => {
  if (!completed) return "in_progress" as const;
  if (item.status === "failed" || item.status === "declined") return "failed" as const;
  if (
    item.type === "command_execution" &&
    typeof item.exit_code === "number" &&
    item.exit_code !== 0
  )
    return "failed" as const;
  return "completed" as const;
};

// A failing Codex turn emits its error twice (an error line, then turn.failed), so
// a repeat of the last assistant text is skipped; true iff an entry was added.
const pushTurnError = (
  entries: Array<CloudTaskChatEntry>,
  turn: number,
  index: number,
  text: string,
) => {
  const last = entries.at(-1);
  if (
    last?._tag === "message" &&
    last.role === "assistant" &&
    last.id.startsWith(`turn-${turn}-`) &&
    last.text === text
  )
    return false;
  entries.push({ _tag: "message", id: `turn-${turn}-${index}`, role: "assistant", text });
  return true;
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
        } else if (
          event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed"
        ) {
          const item = event.item;
          if (!isRecord(item) || typeof item.id !== "string") continue;
          const done = event.type === "item.completed";
          if (item.type === "agent_message") {
            if (done && typeof item.text === "string" && item.text !== "") {
              entries.push({
                _tag: "message",
                id: `turn-${turn.turn}-${(index += 1)}`,
                role: "assistant",
                text: item.text,
              });
            }
          } else if (item.type === "error") {
            if (typeof item.message === "string" && item.message !== "") {
              if (pushTurnError(entries, turn.turn, index + 1, item.message)) index += 1;
            }
          } else if (
            item.type === "command_execution" ||
            item.type === "file_change" ||
            item.type === "mcp_tool_call" ||
            item.type === "web_search"
          ) {
            const status = codexToolStatus(item, done);
            const at = tools.get(item.id);
            if (at === undefined) {
              tools.set(item.id, entries.length);
              if (!done) pending.add(entries.length);
              entries.push({
                _tag: "tool",
                id: `turn-${turn.turn}-${item.id}`,
                title: codexToolTitle(item),
                status,
              });
            } else {
              const entry = entries[at];
              if (entry?._tag === "tool") entries[at] = { ...entry, status };
              if (done) pending.delete(at);
            }
          }
        } else if (event.type === "turn.failed" || event.type === "error") {
          const message =
            isRecord(event.error) && typeof event.error.message === "string"
              ? event.error.message
              : typeof event.message === "string"
                ? event.message
                : null;
          if (message !== null && message !== "") {
            if (pushTurnError(entries, turn.turn, index + 1, message)) index += 1;
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
 * Reads readTurnScript's output, which must already be redacted: a turn without an
 * exit code still runs while its runner lives, and fails when the runner died. A
 * queue item not picked up yet reports pending or dropped. `runId` keeps the id the
 * caller asked about, so a `queued-N` watch follows the item through its turn.
 */
export const replyNeedsInput = (reply: string | null) =>
  reply !== null && /\?(?:\s*$|\s*\n\s*(?:[-*]|[A-D1-4][.)])\s)/.test(reply);

export const parseTurn = (result: CommandResult, runId?: string): TurnState => {
  const [header = "", ...rest] = result.output.split("\n---\n");
  const turn = /turn=(\d*)/.exec(header)?.[1] ?? "";
  const exit = /exit=(\d*)/.exec(header)?.[1] ?? "";
  // An old sandbox has no live= line; counting it as live is the safer read.
  const live = /live=(\d)/.exec(header)?.[1] ?? "1";
  const pending = /pending=1/.test(header);
  const dropped = /dropped=1/.test(header);
  const body = rest.join("\n---\n");
  const markerAt = body.lastIndexOf(ERR_MARKER);
  const out = (markerAt === -1 ? body : body.slice(0, markerAt)).trim();
  const err = markerAt === -1 ? "" : body.slice(markerAt + ERR_MARKER.length).trim();
  let settled: string | undefined;
  let succeeded = false;
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
      if (event.type === "result" && typeof event.result === "string") {
        settled = event.result;
        succeeded = event.subtype === "success" && event.is_error === false;
      }
      if (event.type === "assistant") {
        const text = messageText(event);
        if (text !== null) lastAssistant = text;
      }
      // Codex names the same moments differently: its reply is the last agent_message
      // once its turn completed, or the failure's message when it did not.
      if (event.type === "item.completed") {
        const item = event.item;
        if (isRecord(item) && item.type === "agent_message" && typeof item.text === "string")
          lastAssistant = item.text;
      }
      if (event.type === "turn.completed") settled = lastAssistant;
      if (event.type === "turn.failed") {
        const error = event.error;
        if (isRecord(error) && typeof error.message === "string") settled = error.message;
      }
    }
  }
  const reply = settled ?? lastAssistant ?? (out.length > 0 ? out : err.length > 0 ? err : null);
  const asksForInput = replyNeedsInput(reply);
  const pullRequests = body.match(PULL_REQUEST);
  const id = runId ?? `turn-${turn === "" ? "0" : turn}`;
  const state = dropped
    ? { thread: "blocked" as const, run: "cancelled" as const }
    : pending
      ? live === "1"
        ? { thread: "queued" as const, run: "queued" as const }
        : { thread: "failed" as const, run: "failed" as const }
      : turn === ""
        ? { thread: "queued" as const, run: "queued" as const }
        : exit === ""
          ? live === "1"
            ? { thread: "running" as const, run: "running" as const }
            : { thread: "failed" as const, run: "failed" as const }
          : // E2B can kill the runner during cleanup after Claude persisted its successful result.
            exit === "0" || (exit === "137" && succeeded)
            ? asksForInput
              ? { thread: "blocked" as const, run: "waiting" as const }
              : { thread: "ready" as const, run: "completed" as const }
            : exit === "130"
              ? { thread: "blocked" as const, run: "cancelled" as const }
              : { thread: "failed" as const, run: "failed" as const };
  const latestReply = dropped
    ? "This message was cleared before it ran."
    : pending && live !== "1"
      ? "The sandbox stopped before this message ran. Send it again."
      : exit === "" && live !== "1" && turn !== "" && !pending && !dropped
        ? (reply ?? "The sandbox stopped before this turn finished.")
        : reply;
  return {
    thread: state.thread,
    run: { id, status: state.run },
    latestReply: latestReply === null ? null : latestReply.slice(0, MAX_REPLY_LENGTH),
    pullRequestUrl: pullRequests?.at(-1) ?? null,
  };
};
