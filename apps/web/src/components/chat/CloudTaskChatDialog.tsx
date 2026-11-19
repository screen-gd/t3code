import type { EnvironmentId, NodeId, ThreadId } from "@t3tools/contracts";
import { lazy, Suspense } from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";

// The chat renders markdown, which task rows should not load until one opens.
const CloudTaskChatEntries = lazy(() => import("./CloudTaskChatEntries"));

export function CloudTaskChatLoading() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner className="size-4" />
      Loading chat from Hoplite
    </div>
  );
}

/**
 * The chat of a task delegated to Hoplite, read from Hoplite over ACP by the
 * environment holding the key. It follows the task live while open.
 */
export function CloudTaskChatDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly taskId: NodeId;
  readonly title: string;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-h-[80dvh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>Running in Hoplite</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {props.open ? (
            <Suspense fallback={<CloudTaskChatLoading />}>
              <CloudTaskChatEntries
                environmentId={props.environmentId}
                threadId={props.threadId}
                taskId={props.taskId}
              />
            </Suspense>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
