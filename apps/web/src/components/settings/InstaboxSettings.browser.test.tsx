import { Atom, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { EnvironmentId, type InstaboxInput, type InstaboxResult } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  manage:
    vi.fn<(input: { input: InstaboxInput }) => Promise<AtomCommandResult<InstaboxResult, Error>>>(),
}));

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("../../state/instabox"), () => ({
  manageInstabox: Object.assign(mocks.manage, { permissionAtom: () => Atom.make(true) }) as never,
}));
vi.mock(import("../../connection/onboarding"), () => ({ connectPairing: vi.fn() as never }));

import { InstaboxSettings } from "./InstaboxSettings";

function setup() {
  mocks.manage.mockReset();
  mocks.manage.mockImplementation(async ({ input }) =>
    input.action === "configure"
      ? AsyncResult.success({ configured: true, machines: [], snapshots: [] })
      : AsyncResult.failure(Cause.fail(new Error("Instabox API key expired"))),
  );
}

it("lets users replace an expired saved key after reopening Settings", async () => {
  setup();
  await using screen = await render(
    <InstaboxSettings environmentId={EnvironmentId.make("test")} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Manage Instabox" }));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Instabox API key expired");
  await expect.element(screen.getByLabelText("Instabox API key")).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Instabox API key"), "ibk_replacement_test");
  await userEvent.click(screen.getByRole("button", { name: "Connect account" }));
  await expect.element(screen.getByLabelText("Machine name")).toBeInTheDocument();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});
