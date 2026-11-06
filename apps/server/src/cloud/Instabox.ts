import {
  InstaboxError,
  InstaboxMachine,
  InstaboxSnapshot,
  type InstaboxInput,
  type InstaboxResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const isInstaboxError = Schema.is(InstaboxError);

const KEY = "instabox-api-key";
const Operation = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^op_[a-z0-9]+$/)),
  state: Schema.String,
  machineId: Schema.optionalKey(Schema.String),
});
const MachinePage = Schema.Struct({
  machines: Schema.Array(InstaboxMachine),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const Execution = Schema.Struct({ stdout: Schema.String, exitCode: Schema.Number });

// A separate data directory prevents snapshots from duplicating T3's environment identity.
export const INSTABOX_BOOTSTRAP = `set -eu
export PATH="$HOME/.local/bin:$PATH"
export T3CODE_HOME="$HOME/.t3-cloud/$1"
umask 077
mkdir -p "$T3CODE_HOME/workspace"
if [ ! -f "$T3CODE_HOME/setup" ]; then
  printf '%s\\0' "$2" "$3" "$4" "$5" > "$T3CODE_HOME/setup"
fi
mapfile -d '' -t setup < "$T3CODE_HOME/setup"
set -- "$1" "\${setup[0]}" "\${setup[1]}" "\${setup[2]}" "\${setup[3]}"
if [ ! -f "$T3CODE_HOME/.installed" ]; then
  curl -fsSL https://t3.codes/install.sh -o /tmp/t3-cloud-install.sh
  sh /tmp/t3-cloud-install.sh
  touch "$T3CODE_HOME/.installed"
fi
if [ -n "$2" ] && [ ! -d "$T3CODE_HOME/repository/.git" ]; then
  git clone -- "$2" "$T3CODE_HOME/repository"
fi
if [ -d "$T3CODE_HOME/repository/.git" ]; then
  cd "$T3CODE_HOME/repository"
else
  cd "$T3CODE_HOME/workspace"
fi
t3 up --lan --no-connect --yes --headless >/dev/null
curl --fail --silent --show-error --retry 15 --retry-connrefused --retry-delay 1 \
  http://127.0.0.1:3773/.well-known/t3/environment >/dev/null
if [ ! -f "$T3CODE_HOME/.project-added" ]; then
  t3 project add "$PWD" >/dev/null
  touch "$T3CODE_HOME/.project-added"
fi
if [ -n "$3" ] && [ ! -f "$T3CODE_HOME/.thread-started" ]; then
  t3 thread start --provider "$4" --model "$5" -- "$PWD" "$3" >/dev/null
  touch "$T3CODE_HOME/.thread-started"
fi
t3 pair --base-dir "$T3CODE_HOME"
`;

export function instaboxPairingUrl(output: string, endpoint: string): string {
  const match = /^Pairing URL: (https?:\/\/\S+)$/m.exec(output);
  if (!match?.[1]) throw new Error("Missing T3 pairing URL");
  const pairing = new URL(match[1]);
  const target = new URL(endpoint);
  if (target.protocol !== "https:") throw new Error("Invalid Instabox endpoint");
  target.pathname = pairing.pathname;
  target.search = pairing.search;
  target.hash = pairing.hash;
  return target.toString();
}

export class Instabox extends Context.Service<
  Instabox,
  { readonly manage: (input: InstaboxInput) => Effect.Effect<InstaboxResult, InstaboxError> }
>()("t3/cloud/Instabox") {}

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;

  const request = Effect.fn("Instabox.request")(
    function* <A>(
      key: string,
      path: string,
      schema: Schema.Decoder<A>,
      body?: unknown,
      method: "GET" | "POST" | "DELETE" = body === undefined ? "GET" : "POST",
      confirmation?: string,
    ) {
      let req = HttpClientRequest.make(method)(`https://api.instabox.sh/v1/${path}`).pipe(
        HttpClientRequest.setHeader("X-API-Key", key),
      );
      if (method !== "GET") {
        req = req.pipe(HttpClientRequest.setHeader("Idempotency-Key", yield* random.uuidV4()));
      }
      if (confirmation)
        req = req.pipe(HttpClientRequest.setHeader("X-Confirm-Delete", confirmation));
      if (body !== undefined) req = yield* HttpClientRequest.bodyJson(req, body);
      const response = yield* http.execute(req);
      if (response.status < 200 || response.status >= 300) {
        return yield* new InstaboxError({ operation: "request", status: response.status });
      }
      return yield* HttpClientResponse.schemaBodyJson(schema)(response);
    },
    Effect.timeout("3 minutes"),
    Effect.mapError((error) =>
      isInstaboxError(error) ? error : new InstaboxError({ operation: "request", cause: error }),
    ),
  );

  const wait = Effect.fn("Instabox.wait")(function* (
    key: string,
    operation: typeof Operation.Type,
  ) {
    let current = operation;
    for (let attempt = 0; attempt < 24; attempt++) {
      if (current.state === "succeeded") return;
      if (current.state === "failed" || current.state === "cancelled") {
        return yield* new InstaboxError({ operation: "machine operation" });
      }
      current = yield* request(key, `operations/${operation.id}?wait=25s`, Operation);
    }
    return yield* new InstaboxError({ operation: "operation timed out; refresh machine status" });
  });

  const list = Effect.fn("Instabox.list")(function* (key: string) {
    let page = yield* request(key, "machines", MachinePage);
    const machines = [...page.machines];
    while (page.nextCursor) {
      page = yield* request(
        key,
        `machines?cursor=${encodeURIComponent(page.nextCursor)}`,
        MachinePage,
      );
      machines.push(...page.machines);
    }
    const snapshots = yield* request(
      key,
      "snapshots",
      Schema.Struct({ snapshots: Schema.Array(InstaboxSnapshot) }),
    );
    return { configured: true, machines, snapshots: snapshots.snapshots };
  });

  const connect = Effect.fn("Instabox.connect")(function* (
    key: string,
    machineId: string,
    setup?: Extract<InstaboxInput, { action: "create" }>,
  ) {
    yield* wait(key, yield* request(key, `machines/${machineId}/start`, Operation, {}));
    const execution = yield* request(key, `machines/${machineId}/exec`, Execution, {
      argv: [
        "bash",
        "-lc",
        INSTABOX_BOOTSTRAP,
        "t3-cloud",
        machineId,
        setup?.repositoryUrl ?? "",
        setup?.initialTask ?? "",
        setup?.provider ?? "codex",
        setup?.model ?? "gpt-6-luna",
      ],
      timeoutSeconds: 120,
    });
    if (execution.exitCode !== 0) return yield* new InstaboxError({ operation: "T3 bootstrap" });
    const port = yield* request(
      key,
      `machines/${machineId}/ports`,
      Schema.Struct({ url: Schema.String }),
      {
        port: 3773,
        access: "public",
        name: "T3 Code",
      },
    );
    return yield* Effect.try({
      try: () => instaboxPairingUrl(execution.stdout, port.url),
      catch: (cause) => new InstaboxError({ operation: "pairing", cause }),
    });
  });

  const manage = Effect.fn("Instabox.manage")(
    function* (input: InstaboxInput) {
      if (input.action === "disconnect") {
        yield* secrets.remove(KEY);
        return { configured: false, machines: [], snapshots: [] };
      }
      if (input.action === "configure") {
        const key = Redacted.value(input.apiKey).trim();
        const result = yield* list(key);
        yield* secrets.set(KEY, new TextEncoder().encode(key));
        return result;
      }
      const stored = yield* secrets.get(KEY);
      if (Option.isNone(stored)) {
        if (input.action === "list") return { configured: false, machines: [], snapshots: [] };
        return yield* new InstaboxError({ operation: "account not connected" });
      }
      const key = new TextDecoder().decode(stored.value);
      if (input.action === "list") return yield* list(key);
      let pairingUrl: string | undefined;
      if (input.action === "create") {
        const operation = yield* request(key, "machines", Operation, {
          name: input.name,
          ...(input.snapshotId
            ? { snapshotId: input.snapshotId }
            : { templateId: "agent-browser" }),
          vault: false,
          metadata: { app: "t3code" },
        });
        yield* wait(key, operation);
        if (!operation.machineId) return yield* new InstaboxError({ operation: "create" });
        pairingUrl = yield* connect(key, operation.machineId, input);
      } else {
        const machine = yield* request(key, `machines/${input.machineId}`, InstaboxMachine);
        if (machine.metadata?.app !== "t3code") {
          return yield* new InstaboxError({ operation: "machine is not managed by T3" });
        }
        if (input.action === "connect") pairingUrl = yield* connect(key, input.machineId);
        else {
          const path =
            input.action === "delete"
              ? `machines/${input.machineId}`
              : `machines/${input.machineId}/suspend`;
          const operation = yield* request(
            key,
            path,
            Operation,
            input.action === "delete" ? undefined : {},
            input.action === "delete" ? "DELETE" : "POST",
            input.action === "delete" ? input.machineId : undefined,
          );
          yield* wait(key, operation);
        }
      }
      return { ...(yield* list(key)), ...(pairingUrl ? { pairingUrl } : {}) };
    },
    Effect.mapError((error) =>
      isInstaboxError(error)
        ? error
        : new InstaboxError({ operation: "account storage", cause: error }),
    ),
  );

  return Instabox.of({ manage });
});

export const layer = Layer.effect(Instabox, make);
