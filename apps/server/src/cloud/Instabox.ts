import { CLOUD_BOOTSTRAP, cloudPairingUrl } from "./CloudBootstrap.ts";
import {
  CloudMachineError,
  CloudMachine,
  CloudSnapshot,
  CloudSetupWarning,
  type CloudMachineInput,
  type CloudMachineResult,
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

const isCloudMachineError = Schema.is(CloudMachineError);

const KEY = "instabox-api-key";
const Operation = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^op_[a-z0-9]+$/)),
  state: Schema.String,
  machineId: Schema.optionalKey(Schema.String),
});
const MachinePage = Schema.Struct({
  machines: Schema.Array(CloudMachine),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const Execution = Schema.Struct({ stdout: Schema.String, exitCode: Schema.Number });

export class Instabox extends Context.Service<
  Instabox,
  {
    readonly manage: (
      input: CloudMachineInput,
    ) => Effect.Effect<CloudMachineResult, CloudMachineError>;
  }
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
        return yield* new CloudMachineError({ operation: "request", status: response.status });
      }
      return yield* HttpClientResponse.schemaBodyJson(schema)(response);
    },
    Effect.timeout("3 minutes"),
    Effect.mapError((error) =>
      isCloudMachineError(error)
        ? error
        : new CloudMachineError({ operation: "request", cause: error }),
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
        return yield* new CloudMachineError({ operation: "machine operation" });
      }
      current = yield* request(key, `operations/${operation.id}?wait=25s`, Operation);
    }
    return yield* new CloudMachineError({
      operation: "operation timed out; refresh machine status",
    });
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
      Schema.Struct({ snapshots: Schema.Array(CloudSnapshot) }),
    );
    return { configured: true, machines, snapshots: snapshots.snapshots };
  });

  const connect = Effect.fn("Instabox.connect")(function* (
    key: string,
    machineId: string,
    setup?: Extract<CloudMachineInput, { action: "create" }>,
  ) {
    yield* wait(key, yield* request(key, `machines/${machineId}/start`, Operation, {}));
    const execution = yield* request(key, `machines/${machineId}/exec`, Execution, {
      argv: [
        "bash",
        "-lc",
        CLOUD_BOOTSTRAP,
        "t3-cloud",
        machineId,
        setup?.repositoryUrl ?? "",
        setup?.initialTask ?? "",
        setup?.provider ?? "codex",
        setup?.model ?? "gpt-6-luna",
      ],
      timeoutSeconds: 120,
    });
    if (execution.exitCode !== 0)
      return yield* new CloudMachineError({ operation: "T3 bootstrap" });
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
    const pairingUrl = yield* Effect.try({
      try: () => cloudPairingUrl(execution.stdout, port.url),
      catch: (cause) => new CloudMachineError({ operation: "pairing", cause }),
    });
    const outputLines = execution.stdout.split("\n");
    const setupWarning = CloudSetupWarning.literals.find((warning) =>
      outputLines.includes(`T3_SETUP_WARNING=${warning}`),
    );
    return { pairingUrl, ...(setupWarning ? { setupWarning } : {}) };
  });

  const manage = Effect.fn("Instabox.manage")(
    function* (input: CloudMachineInput) {
      if (input.action === "stop")
        return yield* new CloudMachineError({ operation: "Instabox does not support this action" });
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
        return yield* new CloudMachineError({ operation: "account not connected" });
      }
      const key = new TextDecoder().decode(stored.value);
      if (input.action === "list") return yield* list(key);
      let connection: Pick<CloudMachineResult, "pairingUrl" | "setupWarning"> = {};
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
        if (!operation.machineId) return yield* new CloudMachineError({ operation: "create" });
        connection = yield* connect(key, operation.machineId, input);
      } else {
        const machine = yield* request(key, `machines/${input.machineId}`, CloudMachine);
        if (machine.metadata?.app !== "t3code") {
          return yield* new CloudMachineError({ operation: "machine is not managed by T3" });
        }
        if (input.action === "connect") connection = yield* connect(key, input.machineId);
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
      return { ...(yield* list(key)), ...connection };
    },
    Effect.mapError((error) =>
      isCloudMachineError(error)
        ? error
        : new CloudMachineError({ operation: "account storage", cause: error }),
    ),
  );

  return Instabox.of({ manage });
});

export const layer = Layer.effect(Instabox, make);
