import type { HopliteCloudThreadStatus } from "@t3tools/contracts";

import type { AgentKeys, CommandResult } from "./CloudSandboxProviders.ts";
import type { HopliteRunStatus } from "./HopliteCloudService.ts";

const STATE_DIR = "$HOME/.t3-task";
const MAX_REPLY_LENGTH = 4_000;

/**
 * What runs inside the sandbox for a turn. The prompt, repo and keys arrive as
 * environment variables of this one command, never in its text, so they stay out of
 * the provider's command logs; git reads the token through a credential helper.
 */
export const agentTurnScript = (input: { readonly first: boolean }) =>
  [
    "set -e",
    `mkdir -p "${STATE_DIR}"`,
    `rm -f "${STATE_DIR}/exit"`,
    `echo $(( $(cat "${STATE_DIR}/turn" 2>/dev/null || echo 0) + 1 )) > "${STATE_DIR}/turn"`,
    `git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`,
    ...(input.first
      ? [
          'if [ -n "$T3_TASK_REPO" ] && [ ! -d "$HOME/work/.git" ]; then git clone "https://github.com/$T3_TASK_REPO.git" "$HOME/work"; fi',
        ]
      : []),
    'mkdir -p "$HOME/work" && cd "$HOME/work"',
    `setsid nohup bash -c 'npx -y @anthropic-ai/claude-code -p "$T3_TASK_PROMPT" ${input.first ? "" : "-c "}--dangerously-skip-permissions --output-format json > "${STATE_DIR}/out.json" 2> "${STATE_DIR}/err.log"; echo $? > "${STATE_DIR}/exit"' > /dev/null 2>&1 &`,
    `echo $! > "${STATE_DIR}/pid"`,
  ].join("\n");

export const agentTurnEnv = (
  keys: AgentKeys,
  prompt: string,
  repo: string | undefined,
): Record<string, string> => ({
  ANTHROPIC_API_KEY: keys.anthropicApiKey,
  ...(keys.githubToken === undefined
    ? {}
    : { GH_TOKEN: keys.githubToken, GITHUB_TOKEN: keys.githubToken }),
  T3_TASK_PROMPT: prompt,
  ...(repo === undefined ? {} : { T3_TASK_REPO: repo }),
});

export const READ_TURN_SCRIPT = [
  `echo "turn=$(cat "${STATE_DIR}/turn" 2>/dev/null)"`,
  `echo "exit=$(cat "${STATE_DIR}/exit" 2>/dev/null)"`,
  'echo "---"',
  `tail -c 20000 "${STATE_DIR}/out.json" 2>/dev/null || true`,
  `tail -c 2000 "${STATE_DIR}/err.log" 2>/dev/null || true`,
].join("\n");

// setsid makes the agent's pid its process group, so this stops the agent and its children.
export const STOP_SCRIPT = `kill -- -$(cat "${STATE_DIR}/pid" 2>/dev/null) 2>/dev/null || true; [ -f "${STATE_DIR}/exit" ] || echo 130 > "${STATE_DIR}/exit"`;

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

/** Reads READ_TURN_SCRIPT's output: no exit code yet means the agent still runs. */
export const parseTurn = (result: CommandResult): TurnState => {
  const [header = "", ...rest] = result.output.split("\n---\n");
  const turn = /turn=(\d*)/.exec(header)?.[1] ?? "";
  const exit = /exit=(\d*)/.exec(header)?.[1] ?? "";
  const body = rest.join("\n---\n");
  let reply: string | null = null;
  const json = body.slice(0, body.lastIndexOf("}") + 1);
  try {
    const parsed = JSON.parse(json) as { result?: unknown };
    if (typeof parsed.result === "string") reply = parsed.result;
  } catch {
    reply = body.trim().length > 0 ? body.trim() : null;
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
