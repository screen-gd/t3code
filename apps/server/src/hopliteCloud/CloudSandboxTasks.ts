import type { HopliteCloudThreadStatus } from "@t3tools/contracts";

import type { AgentKeys, CommandResult } from "./CloudSandboxProviders.ts";
import type { HopliteRunStatus } from "./HopliteCloudService.ts";

const STATE_DIR = "$HOME/.t3-task";
const MAX_REPLY_LENGTH = 4_000;
/** agentTurnScript exits with this while the previous turn still runs. */
export const BUSY_EXIT = 75;
const ERR_MARKER = "---t3-task-err---";
// Older sandboxes keep their last turn directly in STATE_DIR.
const CURRENT_STATE = `turn=$(cat "${STATE_DIR}/turn" 2>/dev/null || true); state="${STATE_DIR}/runs/$turn"; [ -d "$state" ] || state="${STATE_DIR}"`;

/**
 * What runs inside the sandbox for a turn. The prompt, repo and keys arrive as
 * environment variables of this one command, never in its text, so they stay out of
 * the provider's command logs; git reads the token through a credential helper.
 */
export const agentTurnScript = (input: { readonly first: boolean }) =>
  [
    "set -e",
    `mkdir -p "${STATE_DIR}"`,
    CURRENT_STATE,
    `if [ ! -f "$state/exit" ] && kill -0 "$(cat "$state/pid" 2>/dev/null)" 2>/dev/null; then exit ${BUSY_EXIT}; fi`,
    `git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`,
    ...(input.first
      ? [
          'if [ -n "$T3_TASK_REPO" ] && [ ! -d "$HOME/work/.git" ]; then git clone "https://github.com/$T3_TASK_REPO.git" "$HOME/work"; fi',
        ]
      : []),
    'mkdir -p "$HOME/work" && cd "$HOME/work"',
    // The turn counts only once its agent starts, so a failed clone leaves no turn waiting.
    "turn=$(( ${turn:-0} + 1 ))",
    `export T3_TASK_STATE="${STATE_DIR}/runs/$turn"`,
    'mkdir -p "$T3_TASK_STATE"',
    `echo "$turn" > "${STATE_DIR}/turn"`,
    `setsid nohup bash -c 'npx -y @anthropic-ai/claude-code -p "$T3_TASK_PROMPT" ${input.first ? "" : "-c "}--dangerously-skip-permissions --output-format json > "$T3_TASK_STATE/out.json" 2> "$T3_TASK_STATE/err.log"; echo $? > "$T3_TASK_STATE/exit"' > /dev/null 2>&1 &`,
    'echo $! > "$T3_TASK_STATE/pid"',
    'echo "turn=$turn"',
  ].join("\n");

/** The run id of the turn agentTurnScript started, from the line it ends with. */
export const startedRunId = (result: CommandResult) => {
  const turn = [...result.output.matchAll(/^turn=(\d+)$/gm)].at(-1)?.[1];
  return turn === undefined ? null : `turn-${turn}`;
};

export const agentTurnEnv = (
  keys: AgentKeys,
  prompt: string,
  repo: string | undefined,
): Record<string, string> => ({
  [keys.claude.variable]: keys.claude.value,
  ...(keys.githubToken === undefined
    ? {}
    : { GH_TOKEN: keys.githubToken, GITHUB_TOKEN: keys.githubToken }),
  T3_TASK_PROMPT: prompt,
  ...(repo === undefined ? {} : { T3_TASK_REPO: repo }),
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
    `echo; echo "${ERR_MARKER}"`,
    'tail -n 40 "$state/err.log" 2>/dev/null || true',
  ].join("\n");

// setsid makes the agent's pid its process group, so this stops the agent and its children.
export const STOP_SCRIPT = `${CURRENT_STATE}; kill -- -$(cat "$state/pid" 2>/dev/null) 2>/dev/null || true; [ -f "$state/exit" ] || echo 130 > "$state/exit"`;

const PULL_REQUEST = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** Keys must never come back in a task's reply, even when the agent prints them. */
export const redact = (text: string, keys: ReadonlyArray<string | undefined>) =>
  keys.reduce<string>(
    (current, key) =>
      key === undefined || key.length < 8 ? current : current.replaceAll(key, "[redacted]"),
    text,
  );

export interface TurnState {
  readonly thread: HopliteCloudThreadStatus;
  readonly run: { readonly id: string; readonly status: HopliteRunStatus };
  readonly latestReply: string | null;
  readonly pullRequestUrl: string | null;
}

/**
 * Reads readTurnScript's output, which must already be redacted: no exit code yet
 * means the agent still runs.
 */
export const parseTurn = (result: CommandResult): TurnState => {
  const [header = "", ...rest] = result.output.split("\n---\n");
  const turn = /turn=(\d*)/.exec(header)?.[1] ?? "";
  const exit = /exit=(\d*)/.exec(header)?.[1] ?? "";
  const body = rest.join("\n---\n");
  const markerAt = body.lastIndexOf(ERR_MARKER);
  const out = (markerAt === -1 ? body : body.slice(0, markerAt)).trim();
  const err = markerAt === -1 ? "" : body.slice(markerAt + ERR_MARKER.length).trim();
  let reply: string | null = null;
  try {
    const parsed = JSON.parse(out) as { result?: unknown };
    if (typeof parsed.result === "string") reply = parsed.result;
  } catch {
    reply = out.length > 0 ? out : err.length > 0 ? err : null;
  }
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
