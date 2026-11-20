import { useAtomValue } from "@effect/atom-react";
import type { NodeId, ScopedThreadRef } from "@t3tools/contracts";
import { ArrowUpIcon, SquareIcon, XIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { lazy, Suspense, useState, type KeyboardEvent } from "react";

import { hopliteCloudEnvironment } from "../../state/hopliteCloud";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";

const HOPLITE = "Hoplite";

// The chat renders markdown, which task rows should not load until one opens.
const CloudTaskChatEntries = lazy(() => import("./CloudTaskChatEntries"));

export function CloudTaskChatLoading() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner className="size-4" />
      <T>Loading chat from Hoplite</T>
    </div>
  );
}

/** Opens a Hoplite task's chat as a tab beside the thread that delegated it. */
export function openCloudTaskChat(parentRef: ScopedThreadRef, taskId: NodeId, title: string) {
  useRightPanelStore.getState().openCloudTask(parentRef, taskId, title);
}

/**
 * A task delegated to Hoplite, as a chat: Hoplite's history and live activity over
 * ACP, read by the environment holding the key, and follow-ups sent as the parent.
 */
export default function CloudTaskChatPane(props: {
  readonly parentRef: ScopedThreadRef;
  readonly taskId: NodeId;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const { parentRef, taskId } = props;
  const status = useAtomValue(
    environmentThreadDetails.threadAtom(parentRef),
    (thread) => thread?.projection.subagents.find((agent) => agent.id === taskId)?.status ?? null,
  );
  const canOperate = useAtomValue(
    hopliteCloudEnvironment.sendTaskMessage.permissionAtom(parentRef.environmentId),
  );
  const sendMessage = useAtomCommand(hopliteCloudEnvironment.sendTaskMessage);
  const stopTask = useAtomCommand(hopliteCloudEnvironment.stopTask);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"send" | "stop" | null>(null);
  const running = status === "running" || status === "pending";
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
          {running ? gt("Running in Hoplite") : HOPLITE}
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
        <Suspense fallback={<CloudTaskChatLoading />}>
          <CloudTaskChatEntries
            environmentId={parentRef.environmentId}
            threadId={parentRef.threadId}
            taskId={taskId}
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
