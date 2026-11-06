import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { InstaboxError, InstaboxInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Instabox from "./Instabox.ts";

const isInstaboxError = Schema.is(InstaboxError);

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
        ...(request.headers["x-confirm-delete"]
          ? { confirmation: request.headers["x-confirm-delete"] }
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
    layer: Instabox.layer.pipe(
      Layer.provide(
        Layer.mergeAll(secrets, Layer.succeed(HttpClient.HttpClient, client), NodeCrypto.layer),
      ),
    ),
  };
}

it.effect("validates a replacement key before saving it and never returns the key", () =>
  Effect.gen(function* () {
    const f = fixture([
      { body: { machines: [] } },
      { body: { snapshots: [] } },
      { status: 401, body: {} },
    ]);
    const service = yield* Instabox.Instabox.pipe(Effect.provide(f.layer));
    expect(
      yield* service.manage({ action: "configure", apiKey: Redacted.make("ibk_test") }),
    ).toEqual({ configured: true, machines: [], snapshots: [] });
    expect(f.stored()).toBe("ibk_test");
    const error = yield* service
      .manage({ action: "configure", apiKey: Redacted.make("bad") })
      .pipe(Effect.flip);
    expect(error.status).toBe(401);
    expect(f.stored()).toBe("ibk_test");
  }),
);

it.effect("does not wake machines while listing and disconnecting only removes the key", () =>
  Effect.gen(function* () {
    const f = fixture(
      [
        { body: { machines: [], nextCursor: "next page" } },
        { body: { machines: [] } },
        { body: { snapshots: [] } },
      ],
      "ibk_test",
    );
    const service = yield* Instabox.Instabox.pipe(Effect.provide(f.layer));
    yield* service.manage({ action: "list" });
    yield* service.manage({ action: "disconnect" });
    expect(yield* service.manage({ action: "list" })).toEqual({
      configured: false,
      machines: [],
      snapshots: [],
    });
    expect(f.calls.map((call) => call.method)).toEqual(["GET", "GET", "GET"]);
    expect(f.calls[1]?.url).toContain("cursor=next%20page");
  }),
);

it.effect(
  "creates from a snapshot, waits for readiness, bootstraps and returns a pairing URL",
  () =>
    Effect.gen(function* () {
      const op = { id: "op_test", machineId: "m_test", state: "running" };
      const f = fixture(
        [
          { body: op },
          { body: { ...op, state: "succeeded" } },
          { body: { ...op, state: "succeeded" } },
          {
            body: { exitCode: 0, stdout: "Pairing URL: http://172.16.0.2:3773/pair#token=TEST\n" },
          },
          { body: { url: "https://3773-test.instabox.tech" } },
          { body: { machines: [] } },
          { body: { snapshots: [] } },
        ],
        "ibk_test",
      );
      const service = yield* Instabox.Instabox.pipe(Effect.provide(f.layer));
      const result = yield* service.manage({
        action: "create",
        name: "test",
        snapshotId: "sn_test",
      });
      expect(result.pairingUrl).toBe("https://3773-test.instabox.tech/pair#token=TEST");
      expect(f.calls[0]?.body).toEqual({
        name: "test",
        snapshotId: "sn_test",
        vault: false,
        metadata: { app: "t3code" },
      });
      expect(f.calls[1]?.url).toContain("operations/op_test?wait=25s");
      expect(f.calls[3]?.body).toMatchObject({
        argv: [
          "bash",
          "-lc",
          Instabox.INSTABOX_BOOTSTRAP,
          "t3-cloud",
          "m_test",
          "",
          "",
          "codex",
          "gpt-6-luna",
        ],
      });
    }),
);

it.effect("refuses to change an existing machine not created by T3", () =>
  Effect.gen(function* () {
    const f = fixture(
      [
        {
          body: {
            id: "m_test",
            name: "personal",
            state: "suspended",
            spec: { vcpus: 4, memMiB: 8192 },
          },
        },
      ],
      "ibk_test",
    );
    const service = yield* Instabox.Instabox.pipe(Effect.provide(f.layer));
    const error = yield* service
      .manage({ action: "delete", machineId: "m_test" })
      .pipe(Effect.flip);
    expect(isInstaboxError(error)).toBe(true);
    expect(f.calls).toHaveLength(1);
  }),
);

it.effect("confirms deletion and stops on a failed operation", () =>
  Effect.gen(function* () {
    const f = fixture(
      [
        {
          body: {
            id: "m_test",
            name: "test",
            state: "suspended",
            spec: { vcpus: 4, memMiB: 8192 },
            metadata: { app: "t3code" },
          },
        },
        { body: { id: "op_test", state: "failed" } },
      ],
      "ibk_test",
    );
    const service = yield* Instabox.Instabox.pipe(Effect.provide(f.layer));
    yield* service.manage({ action: "delete", machineId: "m_test" }).pipe(Effect.flip);
    expect(f.calls[1]).toMatchObject({ method: "DELETE", confirmation: "m_test" });
    expect(f.calls).toHaveLength(2);
  }),
);

it("rejects path injection and malformed pairing output", () => {
  const decode = Schema.decodeUnknownSync(InstaboxInput);
  expect(() => decode({ action: "delete", machineId: "../../other" })).toThrow();
  expect(() => decode({ action: "create", name: "x", repositoryUrl: "ext::sh -c evil" })).toThrow();
  expect(() => Instabox.instaboxPairingUrl("no URL", "https://example.test")).toThrow();
  expect(() =>
    Instabox.instaboxPairingUrl(
      "Pairing URL: http://localhost/pair#token=x",
      "http://example.test",
    ),
  ).toThrow();
});
