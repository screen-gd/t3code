import { useAtomValue } from "@effect/atom-react";
import type { NodeId, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ArrowUpIcon, SquareIcon, XIcon } from "lucide-react";
import { useGT } from "gt-react";
import { lazy, Suspense, useState, type KeyboardEvent } from "react";

import { hopliteCloudEnvironment } from "../../state/hopliteCloud";
import { useEnvironmentQuerySelector } from "../../state/query";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRightPanelStore } from "../../rightPanelStore";
import { cloudSandboxProviderInfo } from "../CloudSandboxLogos";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";

const HOPLITE = "Hoplite";

// The chat renders markdown, which task rows should not load until one opens.
const CloudTaskChatEntries = lazy(() => import("./CloudTaskChatEntries"));

const chatRunning = <E,>(
  result: AsyncResult.AsyncResult<{ readonly running: boolean | null }, E>,
) => AsyncResult.getOrElse(result, () => null)?.running ?? null;

export function CloudTaskChatLoading(props: { readonly provider: string }) {
  const gt = useGT();
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner className="size-4" />
      {gt("Loading chat from {provider}", { provider: props.provider })}
    </div>
  );
}

/** Opens a Hoplite task's chat as a tab beside the thread that delegated it. */
export function openCloudTaskChat(parentRef: ScopedThreadRef, taskId: NodeId, title: string) {
  useRightPanelStore.getState().openCloudTask(parentRef, taskId, title);
}

/**
 * A task delegated to a cloud sandbox, as a chat: its history and live activity,
 * read by the environment holding the key, and follow-ups sent as the parent.
 */
export default function CloudTaskChatPane(props: {
  readonly parentRef: ScopedThreadRef;
  readonly taskId: NodeId;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const { parentRef, taskId } = props;
  const subagent = useAtomValue(
    environmentThreadDetails.threadAtom(parentRef),
    (thread) => thread?.projection.subagents.find((agent) => agent.id === taskId) ?? null,
  );
  const status = subagent?.status ?? null;
  const service = subagent?.remoteChild?.service;
  const provider = service === undefined ? HOPLITE : cloudSandboxProviderInfo(service).name;
  // The same subscription the entries render; it knows about runs started from this pane.
  const chatIsRunning = useEnvironmentQuerySelector(
    hopliteCloudEnvironment.taskChat({
      environmentId: parentRef.environmentId,
      input: { threadId: parentRef.threadId, taskId },
    }),
    chatRunning,
  );
  const canOperate = useAtomValue(
    hopliteCloudEnvironment.sendTaskMessage.permissionAtom(parentRef.environmentId),
  );
  const sendMessage = useAtomCommand(hopliteCloudEnvironment.sendTaskMessage);
  const stopTask = useAtomCommand(hopliteCloudEnvironment.stopTask);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"send" | "stop" | null>(null);
  const running = chatIsRunning ?? (status === "running" || status === "pending");
  const input = { threadId: parentRef.threadId, taskId };

  const send = async () => {
    const message = draft.trim();
    if (message.length === 0 || busy !== null || !canOperate) return;
    setBusy("send");
    const result = await sendMessage({
      environmentId: parentRef.environmentId,
      input: { ...input, message },
    });
    setBusy(null);
    if (result._tag === "Success") setDraft("");
  };

  const stop = async () => {
    if (busy !== null || !canOperate) return;
    setBusy("stop");
    await stopTask({ environmentId: parentRef.environmentId, input });
    setBusy(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div data-side-chat-pane className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{props.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {running ? gt("Running in {provider}", { provider }) : provider}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={gt("Close task chat")}
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <Suspense fallback={<CloudTaskChatLoading provider={provider} />}>
          <CloudTaskChatEntries
            environmentId={parentRef.environmentId}
            threadId={parentRef.threadId}
            taskId={taskId}
            provider={provider}
          />
        </Suspense>
      </div>
      {canOperate ? (
        <div className="shrink-0 border-t border-border p-3">
          <div className="relative">
            <Textarea
              size="sm"
              aria-label={gt("Message the task")}
              placeholder={gt("Message the task")}
              value={draft}
              disabled={busy === "send"}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
            />
            <div className="absolute right-2 bottom-2 flex gap-1">
              {running ? (
                <Button
                  variant="outline"
                  size="icon-xs"
                  aria-label={gt("Stop task")}
                  disabled={busy !== null}
                  onClick={() => void stop()}
                >
                  <SquareIcon />
                </Button>
              ) : null}
              <Button
                size="icon-xs"
                aria-label={gt("Send")}
                disabled={draft.trim().length === 0 || busy !== null}
                onClick={() => void send()}
              >
                {busy === "send" ? <Spinner className="size-3" /> : <ArrowUpIcon />}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
