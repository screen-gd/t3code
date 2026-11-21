import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { secretLock, type SecretLockCommands } from "./secretFileAcl.ts";

const SID = "S-1-5-21-1-2-3-1001";

const recording = (whoami: string) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const commands: SecretLockCommands = {
    output: (command, args) =>
      Effect.sync(() => {
        calls.push([command, ...args]);
        return whoami;
      }),
    run: (command, args) => Effect.sync(() => void calls.push([command, ...args])),
  };
  return { calls, commands };
};

it.effect("locks secrets to the current user's SID on Windows, and does nothing elsewhere", () =>
  Effect.gen(function* () {
    const windows = recording(`"host\\screen","${SID}"\r\n`);
    const lock = yield* secretLock("win32", windows.commands);
    yield* lock("C:\\t3\\secrets", "directory");
    yield* lock("C:\\t3\\secrets\\key.bin", "file");
    assert.deepStrictEqual(windows.calls, [
      ["whoami", "/user", "/fo", "csv", "/nh"],
      ["icacls", "C:\\t3\\secrets", "/inheritance:r", "/grant:r", `*${SID}:(OI)(CI)F`, "/q"],
      ["icacls", "C:\\t3\\secrets\\key.bin", "/inheritance:r", "/grant:r", `*${SID}:F`, "/q"],
    ]);

    const unknownUser = yield* secretLock("win32", recording("ERROR: no user").commands);
    const failed = yield* Effect.flip(unknownUser("C:\\t3\\secrets", "directory"));
    assert.strictEqual(failed._tag, "SecretLockError");

    const posix = recording("");
    const noop = yield* secretLock("linux", posix.commands);
    yield* noop("/t3/secrets", "directory");
    assert.deepStrictEqual(posix.calls, []);
  }),
);
