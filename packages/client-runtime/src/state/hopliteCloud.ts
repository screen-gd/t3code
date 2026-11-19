import { type CloudTaskChatEntry, type CloudTaskChatEvent, WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export interface CloudTaskChat {
  readonly entries: ReadonlyArray<CloudTaskChatEntry>;
  /** False while the history is still replaying. */
  readonly live: boolean;
}

export const EMPTY_CLOUD_TASK_CHAT: CloudTaskChat = { entries: [], live: false };

export function applyCloudTaskChatEvent(
  chat: CloudTaskChat,
  event: CloudTaskChatEvent,
): CloudTaskChat {
  switch (event._tag) {
    case "live":
      return chat.live ? chat : { ...chat, live: true };
    case "upsert": {
      const index = chat.entries.findIndex((entry) => entry.id === event.entry.id);
      if (index === -1) return { ...chat, entries: [...chat.entries, event.entry] };
      const entries = chat.entries.slice();
      entries[index] = event.entry;
      return { ...chat, entries };
    }
    case "append": {
      const index = chat.entries.findLastIndex((entry) => entry.id === event.id);
      const entry = chat.entries[index];
      if (entry?._tag !== "message") return chat;
      const entries = chat.entries.slice();
      entries[index] = { ...entry, text: entry.text + event.text };
      return { ...chat, entries };
    }
  }
}

export function createHopliteCloudEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const settingsWrite = {
    mode: "singleFlight",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:hoplite-cloud:status",
      tag: WS_METHODS.hopliteCloudGetStatus,
    }),
    connect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hoplite-cloud:connect",
      tag: WS_METHODS.hopliteCloudConnect,
      concurrency: settingsWrite,
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hoplite-cloud:disconnect",
      tag: WS_METHODS.hopliteCloudDisconnect,
      concurrency: settingsWrite,
    }),
    taskChat: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:hoplite-cloud:task-chat",
      tag: WS_METHODS.hopliteCloudWatchTaskChat,
      transform: (stream) =>
        stream.pipe(
          Stream.mapAccum(
            () => EMPTY_CLOUD_TASK_CHAT,
            (chat, event) => {
              const next = applyCloudTaskChatEvent(chat, event);
              return [next, [next]] as const;
            },
          ),
        ),
    }),
  };
}
