import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  handleHopliteInboundFrame,
  hopliteAcpAuthStateInit,
  prepareHopliteFrame,
  trackHopliteOutboundFrame,
  type HopliteAcpAuthState,
} from "./HopliteAcpBridge.ts";

const makeAuthState = () => Ref.make<HopliteAcpAuthState>(hopliteAcpAuthStateInit);
const trackInitialize = (state: Ref.Ref<HopliteAcpAuthState>, id: number) =>
  trackHopliteOutboundFrame(
    JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: {} }),
    state,
  );

it.effect("keeps local MCP credentials out of cloud session setup", () =>
  Effect.gen(function* () {
    for (const method of ["session/new", "session/load", "session/resume"]) {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        id: "request-1",
        method,
        params: {
          cwd: "/workspace",
          sessionId: "thread-1",
          mcpServers: [
            { name: "t3", command: "node", env: [{ name: "TOKEN", value: "local-test-secret" }] },
          ],
        },
      });
      const result = yield* prepareHopliteFrame(line);
      assert.notInclude(result, "local-test-secret");
      assert.deepStrictEqual(JSON.parse(result), {
        jsonrpc: "2.0",
        id: "request-1",
        method,
        params: { cwd: "/workspace", sessionId: "thread-1", mcpServers: [] },
      });
    }
  }),
);

it.effect("passes permission replies and prompt content through unchanged", () =>
  Effect.gen(function* () {
    const frame = {
      jsonrpc: "2.0",
      id: 8,
      result: { outcome: { outcome: "selected", optionId: "reject_once" } },
    };
    assert.deepStrictEqual(JSON.parse(yield* prepareHopliteFrame(JSON.stringify(frame))), frame);
    const prompt = {
      jsonrpc: "2.0",
      id: 9,
      method: "session/prompt",
      params: { sessionId: "thread-1", prompt: [{ type: "text", text: "Fix login" }] },
    };
    assert.deepStrictEqual(JSON.parse(yield* prepareHopliteFrame(JSON.stringify(prompt))), prompt);
  }),
);

it.effect("rejects malformed JSON and messages larger than Hoplite accepts", () =>
  Effect.gen(function* () {
    assert.equal((yield* Effect.flip(prepareHopliteFrame("not-json"))).stage, "protocol");
    assert.equal(
      (yield* Effect.flip(prepareHopliteFrame(JSON.stringify({ value: "x".repeat(1024 * 1024) }))))
        .stage,
      "protocol",
    );
  }),
);

it.effect.each([
  { protocolVersion: 1, authMethod: "authenticate" },
  { protocolVersion: 2, authMethod: "auth/login" },
])(
  "withholds the initialize reply until bridge auth succeeds, then drops authMethods (protocol v$protocolVersion)",
  ({ protocolVersion, authMethod }) =>
    Effect.gen(function* () {
      const state = yield* makeAuthState();
      yield* trackInitialize(state, 7);
      const held = yield* handleHopliteInboundFrame(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          result: {
            protocolVersion,
            authMethods: [{ id: "hoplite-api-key", name: "Hoplite API key" }],
          },
        }),
        state,
      );
      assert.isTrue(Option.isNone(held.toClient));
      assert.deepStrictEqual(JSON.parse(Option.getOrThrow(held.toUpstream)), {
        jsonrpc: "2.0",
        id: "t3-hoplite-auth",
        method: authMethod,
        params: { methodId: "hoplite-api-key" },
      });

      const released = yield* handleHopliteInboundFrame(
        JSON.stringify({ jsonrpc: "2.0", id: "t3-hoplite-auth", result: {} }),
        state,
      );
      assert.isTrue(Option.isNone(released.toUpstream));
      assert.deepStrictEqual(JSON.parse(Option.getOrThrow(released.toClient)), {
        jsonrpc: "2.0",
        id: 7,
        result: { protocolVersion, authMethods: [] },
      });

      const later = yield* handleHopliteInboundFrame(
        JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} }),
        state,
      );
      assert.isTrue(Option.isNone(later.toUpstream));
    }),
);

it.effect("never forwards the bridge authenticate reply to the client", () =>
  Effect.gen(function* () {
    const state = yield* makeAuthState();
    yield* trackInitialize(state, 3);
    const actions = yield* Effect.forEach(
      [
        JSON.stringify({ jsonrpc: "2.0", id: 3, result: { protocolVersion: 1 } }),
        JSON.stringify({ jsonrpc: "2.0", id: "t3-hoplite-auth", result: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: 5, result: { sessionId: "s-1" } }),
      ],
      (line) => handleHopliteInboundFrame(line, state),
    );
    const clientFrames = actions.flatMap((action) =>
      Option.isSome(action.toClient) ? [JSON.parse(action.toClient.value)] : [],
    );
    assert.deepStrictEqual(
      clientFrames.map((frame) => frame.id),
      [3, 5],
    );
  }),
);

it.effect("fails with a credential error when upstream auth is rejected", () =>
  Effect.gen(function* () {
    const state = yield* makeAuthState();
    yield* trackInitialize(state, 9);
    yield* handleHopliteInboundFrame(
      JSON.stringify({ jsonrpc: "2.0", id: 9, result: { protocolVersion: 1 } }),
      state,
    );
    const error = yield* Effect.flip(
      handleHopliteInboundFrame(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "t3-hoplite-auth",
          error: { code: -32000, message: "Authentication required." },
        }),
        state,
      ),
    );
    assert.equal(error.stage, "credential");
  }),
);

it.effect("forwards upstream notifications while bridge auth is in flight", () =>
  Effect.gen(function* () {
    const state = yield* makeAuthState();
    yield* trackInitialize(state, 4);
    yield* handleHopliteInboundFrame(
      JSON.stringify({ jsonrpc: "2.0", id: 4, result: { protocolVersion: 1 } }),
      state,
    );
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s-1", update: { sessionUpdate: "agent_message_chunk" } },
    });
    const action = yield* handleHopliteInboundFrame(notification, state);
    assert.isTrue(Option.isNone(action.toUpstream));
    assert.equal(Option.getOrThrow(action.toClient), notification);
  }),
);
