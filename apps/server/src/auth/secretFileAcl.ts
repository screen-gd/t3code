import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export class SecretLockError extends Schema.TaggedError<SecretLockError>()("SecretLockError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `Could not lock secrets to the current user: ${this.detail}`;
  }
}

const isSecretLockError = Schema.is(SecretLockError);

export type SecretPathKind = "directory" | "file";

export interface SecretLockCommands {
  /** A command's stdout. */
  readonly output: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, SecretLockError>;
  /** Fails unless the command exits 0. */
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, SecretLockError>;
}

/**
 * Windows ignores `chmod`, so there secrets are locked to the current user's SID with
 * `icacls`: inherited access is dropped and only that user keeps full control. A locked
 * directory passes the same ACL to files created in it. Elsewhere the store's
 * `0o600`/`0o700` modes already do this and locking is a no-op.
 */
export const secretLock = Effect.fnUntraced(function* (
  platform: NodeJS.Platform,
  commands: SecretLockCommands,
) {
  if (platform !== "win32") {
    return (_path: string, _kind: SecretPathKind): Effect.Effect<void, SecretLockError> =>
      Effect.void;
  }
  // `whoami /user /fo csv /nh` prints `"host\user","S-1-5-21-…"`.
  const sid = yield* Effect.cached(
    commands.output("whoami", ["/user", "/fo", "csv", "/nh"]).pipe(
      Effect.flatMap((output) => {
        const parsed = /"(S-1-[0-9-]+)"/.exec(output)?.[1];
        return parsed === undefined
          ? Effect.fail(new SecretLockError({ detail: "whoami printed no SID" }))
          : Effect.succeed(parsed);
      }),
    ),
  );
  return (path: string, kind: SecretPathKind): Effect.Effect<void, SecretLockError> =>
    sid.pipe(
      Effect.flatMap((current) =>
        commands.run("icacls", [
          path,
          "/inheritance:r",
          "/grant:r",
          `*${current}:${kind === "directory" ? "(OI)(CI)F" : "F"}`,
          "/q",
        ]),
      ),
    );
});

export const makeSecretLock = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
  const withSpawner = <A>(
    command: string,
    use: (
      spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    ) => Effect.Effect<A, PlatformError.PlatformError | SecretLockError>,
  ) =>
    Option.match(spawner, {
      onNone: () => Effect.fail(new SecretLockError({ detail: `cannot run ${command}` })),
      onSome: (service) =>
        use(service).pipe(
          Effect.mapError((cause) =>
            isSecretLockError(cause)
              ? cause
              : new SecretLockError({ detail: `${command}: ${String(cause)}` }),
          ),
        ),
    });
  return yield* secretLock(platform, {
    output: (command, args) =>
      withSpawner(command, (service) =>
        service.string(ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" })),
      ),
    run: (command, args) =>
      withSpawner(command, (service) =>
        service
          .exitCode(
            ChildProcess.make(command, args, {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(
            Effect.flatMap((code) =>
              code === 0
                ? Effect.void
                : Effect.fail(new SecretLockError({ detail: `${command} exited with ${code}` })),
            ),
          ),
      ),
  });
});
