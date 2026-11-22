import type { CloudTaskChatEntry, EnvironmentId, NodeId, ThreadId } from "@t3tools/contracts";
import { T } from "gt-react";
import { CheckIcon, CircleAlertIcon, WrenchIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { hopliteCloudEnvironment } from "../../state/hopliteCloud";
import { useEnvironmentQuery } from "../../state/query";
import ChatMarkdown from "../ChatMarkdown";
import { CloudTaskChatLoading } from "./CloudTaskChatPane";

export default function CloudTaskChatEntries(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly taskId: NodeId;
  readonly provider: string;
}) {
  const chat = useEnvironmentQuery(
    hopliteCloudEnvironment.taskChat({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, taskId: props.taskId },
    }),
  );
  if (chat.error !== null && chat.data === null) {
    return <p className="text-sm text-destructive">{chat.error}</p>;
  }
  if (chat.data === null || (!chat.data.live && chat.data.entries.length === 0)) {
    return <CloudTaskChatLoading provider={props.provider} />;
  }
  if (chat.data.entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        <T>No messages yet.</T>
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-3">
      {chat.data.entries.map((entry) => (
        <CloudTaskChatRow key={entry.id} entry={entry} />
      ))}
      {chat.error !== null ? <li className="text-xs text-destructive">{chat.error}</li> : null}
    </ol>
  );
}

function CloudTaskChatRow(props: { readonly entry: CloudTaskChatEntry }) {
  const { entry } = props;
  if (entry._tag === "tool") {
    const Icon =
      entry.status === "completed"
        ? CheckIcon
        : entry.status === "failed"
          ? CircleAlertIcon
          : WrenchIcon;
    return (
      <li className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Icon
          aria-hidden
          className={cn("size-3.5 shrink-0", entry.status === "failed" && "text-destructive")}
        />
        <span className="truncate">{entry.title}</span>
      </li>
    );
  }
  return entry.role === "user" ? (
    <li className="max-w-[85%] self-end whitespace-pre-wrap rounded-lg bg-secondary px-3 py-2 text-sm">
      {entry.text}
    </li>
  ) : (
    <li className="min-w-0 text-sm">
      <ChatMarkdown text={entry.text} cwd={undefined} />
    </li>
  );
}
