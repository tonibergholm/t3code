import {
  CloudMachineError,
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
import { boatBootstrapCommand, cloudPairingUrl } from "./CloudBootstrap.ts";

const KEY = "boat-api-key";
const isCloudMachineError = Schema.is(CloudMachineError);
const Sandbox = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/)),
  name: Schema.String,
  state: Schema.String,
  labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  vcpu: Schema.optionalKey(Schema.Number),
  memoryGB: Schema.optionalKey(Schema.Number),
  type: Schema.optionalKey(Schema.Literals(["small", "default", "large", "xlarge"])),
});
const SandboxResponse = Schema.Struct({ sandbox: Sandbox });
const SandboxPage = Schema.Struct({
  sandboxes: Schema.Array(Sandbox),
  pageInfo: Schema.Struct({ nextCursor: Schema.NullOr(Schema.String), hasMore: Schema.Boolean }),
});
const SnapshotList = Schema.Struct({
  snapshots: Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String })),
});
const CommandResult = Schema.Struct({
  stdout: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
});
const Deletion = Schema.Struct({ operation: Schema.Struct({ status: Schema.String }) });

const machine = (sandbox: typeof Sandbox.Type) => {
  const sizes = { small: [2, 4], default: [4, 8], large: [8, 16], xlarge: [16, 32] } as const;
  const size = sandbox.type ? sizes[sandbox.type] : [0, 0];
  return {
    id: sandbox.id,
    name: sandbox.name,
    state:
      sandbox.state === "archived"
        ? "stopped"
        : ["ready", "idle", "running"].includes(sandbox.state)
          ? "running"
          : sandbox.state,
    spec: {
      vcpus: sandbox.vcpu ?? size[0] ?? 0,
      memMiB: (sandbox.memoryGB ?? size[1] ?? 0) * 1024,
    },
    ...(sandbox.labels ? { metadata: sandbox.labels } : {}),
  };
};

export class Boat extends Context.Service<
  Boat,
  {
    readonly manage: (
      input: CloudMachineInput,
    ) => Effect.Effect<CloudMachineResult, CloudMachineError>;
  }
>()("t3/cloud/Boat") {}

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;

  const request = Effect.fn("Boat.request")(
    function* <A>(
      key: string,
      path: string,
      schema: Schema.Decoder<A>,
      body?: unknown,
      method: "GET" | "POST" | "DELETE" = body === undefined ? "GET" : "POST",
      confirmation?: string,
    ) {
      let req = HttpClientRequest.make(method)(`https://boat.dev/api/v1/${path}`).pipe(
        HttpClientRequest.bearerToken(key),
      );
      if (method !== "GET")
        req = req.pipe(HttpClientRequest.setHeader("Idempotency-Key", yield* random.uuidV4()));
      if (confirmation)
        req = req.pipe(HttpClientRequest.setHeader("X-Ascii-Confirm-Delete", confirmation));
      if (body !== undefined) req = yield* HttpClientRequest.bodyJson(req, body);
      const response = yield* http.execute(req);
      if (response.status < 200 || response.status >= 300)
        return yield* new CloudMachineError({ operation: "Boat request", status: response.status });
      return yield* HttpClientResponse.schemaBodyJson(schema)(response);
    },
    Effect.timeout("3 minutes"),
    Effect.mapError((error) =>
      isCloudMachineError(error)
        ? error
        : new CloudMachineError({ operation: "Boat request", cause: error }),
    ),
  );

  const wait = Effect.fn("Boat.wait")(function* (
    key: string,
    sandbox: typeof Sandbox.Type,
    stopped = false,
  ) {
    let current = sandbox;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (
        stopped
          ? current.state === "archived"
          : ["ready", "idle", "running"].includes(current.state)
      )
        return current;
      if (["error", "cancelled"].includes(current.state))
        return yield* new CloudMachineError({ operation: "Boat machine operation" });
      yield* Effect.sleep("1 second");
      current = (yield* request(key, `sandboxes/${sandbox.id}`, SandboxResponse)).sandbox;
    }
    return yield* new CloudMachineError({
      operation: "Boat operation timed out; refresh machine status",
    });
  });

  const list = Effect.fn("Boat.list")(function* (key: string) {
    let page = yield* request(key, "sandboxes", SandboxPage);
    const machines = page.sandboxes.map(machine);
    while (page.pageInfo.hasMore && page.pageInfo.nextCursor) {
      page = yield* request(
        key,
        `sandboxes?cursor=${encodeURIComponent(page.pageInfo.nextCursor)}`,
        SandboxPage,
      );
      machines.push(...page.sandboxes.map(machine));
    }
    const snapshots = yield* request(key, "saved-snapshots", SnapshotList);
    return {
      configured: true,
      machines,
      snapshots: snapshots.snapshots
        .filter((snapshot) => snapshot.status === "ready")
        .map((snapshot) => ({ id: snapshot.name, name: snapshot.name })),
    };
  });

  const connect = Effect.fn("Boat.connect")(function* (
    key: string,
    sandbox: typeof Sandbox.Type,
    setup?: Extract<CloudMachineInput, { action: "create" }>,
  ) {
    if (sandbox.state === "archived")
      sandbox = (yield* request(key, `sandboxes/${sandbox.id}/resume`, SandboxResponse, {
        ttlSeconds: 3600,
      })).sandbox;
    yield* wait(key, sandbox);
    const execution = yield* request(key, `sandboxes/${sandbox.id}/commands`, CommandResult, {
      command: boatBootstrapCommand(sandbox.id, setup),
      timeoutSeconds: 120,
    });
    if (execution.exitCode !== 0)
      return yield* new CloudMachineError({ operation: "Boat T3 bootstrap" });
    const endpoint = yield* request(
      key,
      `sandboxes/${sandbox.id}/host`,
      Schema.Struct({ url: Schema.String }),
      { port: 3773, public: true, title: "T3 Code" },
    );
    const pairingUrl = yield* Effect.try({
      try: () => cloudPairingUrl(execution.stdout, endpoint.url),
      catch: (cause) => new CloudMachineError({ operation: "Boat pairing", cause }),
    });
    const outputLines = execution.stdout.split("\n");
    const setupWarning = CloudSetupWarning.literals.find((warning) =>
      outputLines.includes(`T3_SETUP_WARNING=${warning}`),
    );
    return { pairingUrl, ...(setupWarning ? { setupWarning } : {}) };
  });

  const manage = Effect.fn("Boat.manage")(
    function* (input: CloudMachineInput) {
      if (input.action === "pause")
        return yield* new CloudMachineError({
          operation: "Boat does not support memory suspension; stop instead",
        });
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
        return yield* new CloudMachineError({ operation: "Boat account not connected" });
      }
      const key = new TextDecoder().decode(stored.value);
      if (input.action === "list") return yield* list(key);
      let connection: Pick<CloudMachineResult, "pairingUrl" | "setupWarning" | "deletionPending"> =
        {};
      if (input.action === "create") {
        const { sandbox } = yield* request(key, "sandboxes", SandboxResponse, {
          name: input.name,
          type: "default",
          ttlSeconds: 3600,
          labels: { app: "t3code" },
          snapshots: true,
          ...(input.snapshotId ? { from: input.snapshotId } : {}),
        });
        connection = yield* connect(key, sandbox, input);
      } else {
        const { sandbox } = yield* request(key, `sandboxes/${input.machineId}`, SandboxResponse);
        if (sandbox.labels?.app !== "t3code")
          return yield* new CloudMachineError({ operation: "Boat machine is not managed by T3" });
        if (input.action === "connect") connection = yield* connect(key, sandbox);
        else if (input.action === "stop") {
          if (sandbox.state !== "archived")
            yield* wait(
              key,
              (yield* request(key, `sandboxes/${input.machineId}/stop`, SandboxResponse, {}))
                .sandbox,
              true,
            );
        } else {
          const result = yield* request(
            key,
            `sandboxes/${input.machineId}`,
            Deletion,
            undefined,
            "DELETE",
            input.machineId,
          );
          connection = { deletionPending: result.operation.status !== "completed" };
        }
      }
      return { ...(yield* list(key)), ...connection };
    },
    Effect.mapError((error) =>
      isCloudMachineError(error)
        ? error
        : new CloudMachineError({ operation: "Boat account storage", cause: error }),
    ),
  );
  return Boat.of({ manage });
});
export const layer = Layer.effect(Boat, make);
