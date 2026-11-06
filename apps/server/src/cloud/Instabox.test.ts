import { CLOUD_BOOTSTRAP, boatBootstrapCommand, cloudPairingUrl } from "./CloudBootstrap.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { CloudMachineError, CloudMachineInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Instabox from "./Instabox.ts";

const isCloudMachineError = Schema.is(CloudMachineError);

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
            body: {
              exitCode: 0,
              stdout:
                "Pairing URL: http://172.16.0.2:3773/pair#token=TEST\nT3_SETUP_WARNING=repository\n",
            },
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
      expect(result.setupWarning).toBe("repository");
      expect(f.calls[0]?.body).toEqual({
        name: "test",
        snapshotId: "sn_test",
        vault: false,
        metadata: { app: "t3code" },
      });
      expect(f.calls[1]?.url).toContain("operations/op_test?wait=25s");
      expect(f.calls[3]?.body).toMatchObject({
        argv: ["bash", "-lc", CLOUD_BOOTSTRAP, "t3-cloud", "m_test", "", "", "codex", "gpt-6-luna"],
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
    expect(isCloudMachineError(error)).toBe(true);
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
  const decode = Schema.decodeUnknownSync(CloudMachineInput);
  expect(() => decode({ action: "delete", machineId: "../../other" })).toThrow();
  expect(() => decode({ action: "create", name: "x", repositoryUrl: "ext::sh -c evil" })).toThrow();
  expect(() => cloudPairingUrl("no URL", "https://example.test")).toThrow();
  expect(() =>
    cloudPairingUrl("Pairing URL: http://localhost/pair#token=x", "http://example.test"),
  ).toThrow();
});

it.live.each(["repository", "project", "task"] as const)(
  "keeps pairing available when optional %s setup fails, including on reconnect",
  (stage) =>
    Effect.gen(function* () {
      const environment = yield* HostProcess.Environment;
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-instabox-bootstrap-"));
      try {
        const bin = NodePath.join(home, "bin");
        const state = NodePath.join(home, ".t3-cloud", "m_test");
        NodeFS.mkdirSync(bin);
        NodeFS.mkdirSync(state, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(state, ".installed"), "");
        const programs = {
          curl: "#!/bin/sh\nexit 0\n",
          git: '#!/bin/sh\n[ "$FAIL_STAGE" != repository ] || exit 128\nfor last; do :; done\nmkdir -p "$last/.git"\n',
          t3: '#!/bin/sh\nprintf "%s\\n" "$1" >> "$CALLS"\nif [ "$1" = project ] && [ "$FAIL_STAGE" = project ]; then exit 1; fi\nif [ "$1" = thread ] && [ "$FAIL_STAGE" = task ]; then exit 1; fi\nif [ "$1" = pair ]; then echo "Pairing URL: http://localhost:3773/pair#token=TEST"; fi\n',
        };
        for (const [name, contents] of Object.entries(programs)) {
          NodeFS.writeFileSync(NodePath.join(bin, name), contents, { mode: 0o755 });
        }
        const calls = NodePath.join(home, "calls");
        for (const setup of [
          ["https://example.test/repository.git", "initial task", "codex", "model"],
          ["", "", "codex", "model"],
        ]) {
          const result = NodeChildProcess.spawnSync(
            "bash",
            ["-c", CLOUD_BOOTSTRAP, "test", "m_test", ...setup],
            {
              encoding: "utf8",
              env: {
                ...environment,
                HOME: home,
                PATH: `${bin}:${environment.PATH ?? ""}`,
                FAIL_STAGE: stage,
                CALLS: calls,
              },
            },
          );
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain("Pairing URL:");
          expect(result.stdout).toContain(`T3_SETUP_WARNING=${stage}`);
        }
        if (stage !== "task") expect(NodeFS.readFileSync(calls, "utf8")).not.toContain("thread");
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    }),
);

it("preserves shell metacharacters as literal Boat bootstrap arguments", () => {
  const task = "Handle 'quotes', $(printf injected), `printf injected`, and\nnewlines";
  const command = boatBootstrapCommand("bx_23456789", {
    action: "create",
    name: "test",
    initialTask: task,
  });
  const output = NodeChildProcess.execFileSync(
    "sh",
    ["-c", `set -- ${command}; printf '%s\\0' "$@"`],
    { encoding: "utf8" },
  );
  expect(output.split("\0")).toEqual([
    "bash",
    "-lc",
    CLOUD_BOOTSTRAP,
    "t3-cloud",
    "bx_23456789",
    "",
    task,
    "codex",
    "gpt-6-luna",
    "",
  ]);
});
