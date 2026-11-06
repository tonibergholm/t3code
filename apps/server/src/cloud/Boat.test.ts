import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Boat from "./Boat.ts";

function fixture(
  replies: ReadonlyArray<{ readonly status?: number; readonly body: unknown }>,
  key?: string,
) {
  const calls: Array<{ url: string; method: string; body: unknown; confirmation?: string }> = [];
  let stored = key;
  let index = 0;
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      calls.push({
        url: request.url,
        method: request.method,
        body:
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined,
        ...(request.headers["x-ascii-confirm-delete"]
          ? { confirmation: request.headers["x-ascii-confirm-delete"] }
          : {}),
      });
      const reply = replies[index++];
      if (!reply) throw new Error(`Unexpected request ${request.url}`);
      return HttpClientResponse.fromWeb(
        request,
        Response.json(reply.body, { status: reply.status ?? 200 }),
      );
    }),
  );
  const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: () =>
      Effect.succeed(stored ? Option.some(new TextEncoder().encode(stored)) : Option.none()),
    set: (_name, bytes) =>
      Effect.sync(() => {
        stored = new TextDecoder().decode(bytes);
      }),
    remove: () =>
      Effect.sync(() => {
        stored = undefined;
      }),
  });
  return {
    calls,
    stored: () => stored,
    layer: Boat.layer.pipe(
      Layer.provide(
        Layer.mergeAll(secrets, Layer.succeed(HttpClient.HttpClient, client), NodeCrypto.layer),
      ),
    ),
  };
}

const sandbox = {
  id: "bx_23456789",
  name: "test",
  state: "ready",
  type: "default",
  labels: { app: "t3code" },
};
const emptyPage = { sandboxes: [], pageInfo: { hasMore: false, nextCursor: null } };
const snapshots = {
  snapshots: [
    { name: "agent-template", status: "ready" },
    { name: "saving", status: "saving" },
  ],
};

it.effect(
  "paginates without waking machines and validates keys before replacing the saved key",
  () =>
    Effect.gen(function* () {
      const f = fixture([
        {
          body: {
            ...emptyPage,
            sandboxes: [{ ...sandbox, state: "archived" }],
            pageInfo: { hasMore: true, nextCursor: "next page" },
          },
        },
        { body: emptyPage },
        { body: snapshots },
        { status: 401, body: {} },
      ]);
      const service = yield* Boat.Boat.pipe(Effect.provide(f.layer));
      const result = yield* service.manage({
        action: "configure",
        apiKey: Redacted.make("boat_test"),
      });
      expect(result.machines[0]).toMatchObject({
        state: "stopped",
        spec: { vcpus: 4, memMiB: 8192 },
      });
      expect(result.snapshots).toEqual([{ id: "agent-template", name: "agent-template" }]);
      expect(f.calls[1]?.url).toContain("cursor=next%20page");
      expect(f.calls.every((call) => call.method === "GET")).toBe(true);
      expect(
        yield* service
          .manage({ action: "configure", apiKey: Redacted.make("expired") })
          .pipe(Effect.flip),
      ).toMatchObject({ status: 401 });
      expect(f.stored()).toBe("boat_test");
      yield* service.manage({ action: "disconnect" });
      expect(yield* service.manage({ action: "list" })).toEqual({
        configured: false,
        machines: [],
        snapshots: [],
      });
    }),
);

it.effect(
  "creates from a saved snapshot with a cost cap and preserves pairing after optional setup fails",
  () =>
    Effect.gen(function* () {
      const f = fixture(
        [
          { body: { sandbox: { ...sandbox, state: "provisioning" } } },
          { body: { sandbox } },
          {
            body: {
              exitCode: 0,
              stdout:
                "Pairing URL: http://localhost:3773/pair#token=TEST\nT3_SETUP_WARNING=repository\n",
            },
          },
          { body: { url: "https://test.boat.dev" } },
          { body: emptyPage },
          { body: snapshots },
        ],
        "boat_test",
      );
      const service = yield* Boat.Boat.pipe(Effect.provide(f.layer));
      const pending = yield* service
        .manage({
          action: "create",
          name: "test",
          snapshotId: "agent-template",
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(pending);
      expect(result).toMatchObject({
        pairingUrl: "https://test.boat.dev/pair#token=TEST",
        setupWarning: "repository",
      });
      expect(f.calls[0]?.body).toEqual({
        name: "test",
        type: "default",
        ttlSeconds: 3600,
        labels: { app: "t3code" },
        snapshots: true,
        from: "agent-template",
      });
      expect(f.calls[3]?.body).toEqual({ port: 3773, public: true, title: "T3 Code" });
    }),
);

it.effect("resumes stopped machines before bootstrap and refuses unrelated machines", () =>
  Effect.gen(function* () {
    const f = fixture(
      [
        { body: { sandbox: { ...sandbox, state: "archived" } } },
        { body: { sandbox } },
        { body: { exitCode: 0, stdout: "Pairing URL: http://localhost:3773/pair#token=TEST" } },
        { body: { url: "https://test.boat.dev" } },
        { body: emptyPage },
        { body: snapshots },
        { body: { sandbox: { ...sandbox, labels: {} } } },
      ],
      "boat_test",
    );
    const service = yield* Boat.Boat.pipe(Effect.provide(f.layer));
    yield* service.manage({ action: "connect", machineId: sandbox.id });
    expect(f.calls[1]).toMatchObject({ method: "POST", body: { ttlSeconds: 3600 } });
    expect(f.calls[1]?.url).toContain("/resume");
    expect(
      yield* service.manage({ action: "delete", machineId: sandbox.id }).pipe(Effect.flip),
    ).toMatchObject({ operation: "Boat machine is not managed by T3" });
    expect(f.calls).toHaveLength(7);
  }),
);

it.effect("stops without deleting and reports asynchronous deletion honestly", () =>
  Effect.gen(function* () {
    const f = fixture(
      [
        { body: { sandbox } },
        { body: { sandbox: { ...sandbox, state: "archived" } } },
        { body: emptyPage },
        { body: snapshots },
        { body: { sandbox: { ...sandbox, state: "archived" } } },
        { body: { operation: { status: "pending" } } },
        { body: emptyPage },
        { body: snapshots },
      ],
      "boat_test",
    );
    const service = yield* Boat.Boat.pipe(Effect.provide(f.layer));
    yield* service.manage({ action: "stop", machineId: sandbox.id });
    expect(f.calls[1]?.url).toContain("/stop");
    expect(f.calls.slice(0, 4).every((call) => call.method !== "DELETE")).toBe(true);
    expect(yield* service.manage({ action: "delete", machineId: sandbox.id })).toMatchObject({
      deletionPending: true,
    });
    expect(f.calls[5]).toMatchObject({ method: "DELETE", confirmation: sandbox.id });
  }),
);
