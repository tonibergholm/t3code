import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, CloudMachineInput, CloudMachineResult } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Redacted from "effect/Redacted";
import { useState } from "react";
import { connectPairing } from "../../connection/onboarding";
import { manageInstabox, manageBoat } from "../../state/cloudMachines";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "../ui/alert-dialog";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function CloudMachinesSettings({
  environmentId,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: "instabox" | "boat";
}) {
  const label = provider === "boat" ? "Boat" : "Instabox";
  const command = provider === "boat" ? manageBoat : manageInstabox;
  const allowed = useAtomValue(command.permissionAtom(environmentId));
  const canPair = useAtomValue(
    command.permissionAtom(environmentId, { action: "create", name: "permission-check" }),
  );
  const canConfigure = useAtomValue(
    command.permissionAtom(environmentId, { action: "disconnect" }),
  );
  const manage = useAtomCommand(command, { reportFailure: false });
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
  const [account, setAccount] = useState<CloudMachineResult | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("t3-workspace");
  const [snapshotId, setSnapshotId] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [initialTask, setInitialTask] = useState("");
  const [agentProvider, setAgentProvider] = useState<"codex" | "claudeAgent">("codex");
  const [model, setModel] = useState("gpt-6-luna");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const perform = async (input: CloudMachineInput) => {
    setBusy(true);
    setError(null);
    const result = await manage({ environmentId, input });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error ? cause.message : "Cloud operation failed. Refresh and retry.",
      );
      const refreshed = await manage({ environmentId, input: { action: "list" } });
      if (refreshed._tag === "Success") setAccount(refreshed.value);
      setBusy(false);
      return;
    }
    setAccount(result.value);
    if (input.action === "configure") setApiKey("");
    if (result.value.deletionPending)
      setError("Boat accepted deletion. Stored data is being erased in the background.");
    if (result.value.setupWarning) {
      setError(
        `The machine is ready, but ${result.value.setupWarning} setup failed. Open the environment to repair its setup, then connect again to retry.`,
      );
    }
    if (result.value.pairingUrl) {
      const connected = await pair({ pairingUrl: result.value.pairingUrl });
      if (connected._tag === "Failure") {
        const cause = squashAtomCommandFailure(connected);
        setError(
          cause instanceof Error
            ? cause.message
            : "Machine created. Connect again to retry pairing.",
        );
      }
    }
    setBusy(false);
  };

  return (
    <SettingsSection title={`${label} cloud`} id={`${provider}-cloud`}>
      <SettingsRow
        title="Cloud environments"
        description={`Create a Linux machine with your snapshot's tools and skills. Your ${label} account pays for compute.`}
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={!allowed || busy}
            onClick={() => void perform({ action: "list" })}
          >
            {busy ? "Working…" : account ? "Refresh" : `Manage ${label}`}
          </Button>
        }
      />
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {account?.configured === false || (account === null && error !== null) ? (
        <form
          className="flex flex-wrap items-end gap-2 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void perform({ action: "configure", apiKey: Redacted.make(apiKey) });
          }}
        >
          <div className="min-w-48 flex-1">
            <label htmlFor={`${provider}-api-key`} className="text-sm">
              {label} API key
            </label>
            <Input
              id={`${provider}-api-key`}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={busy || !canConfigure || !apiKey.trim()}>
            Connect account
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            Stored in this T3 host's secret store. Requires machine and snapshot management
            permissions.
          </p>
        </form>
      ) : null}
      {provider === "boat" ? (
        <p className="px-4 text-xs text-muted-foreground">
          Stopping ends running processes. Disk snapshots are retained for at least 14 days; resume
          restarts T3. Boat auto-stops machines after one hour by default.
        </p>
      ) : null}
      {account?.configured ? (
        <div className="space-y-4 p-4">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void perform({
                action: "create",
                name,
                ...(snapshotId ? { snapshotId } : {}),
                ...(repositoryUrl.trim() ? { repositoryUrl: repositoryUrl.trim() } : {}),
                ...(initialTask.trim()
                  ? { initialTask: initialTask.trim(), provider: agentProvider, model }
                  : {}),
              });
            }}
          >
            <div className="min-w-40 flex-1">
              <label htmlFor={`${provider}-name`} className="text-sm">
                Machine name
              </label>
              <Input
                id={`${provider}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                pattern="[a-zA-Z0-9][a-zA-Z0-9-]{0,62}"
                required
              />
            </div>
            <div className="min-w-48 flex-1">
              <label className="text-sm" htmlFor={`${provider}-snapshot`}>
                Setup snapshot
              </label>
              <Select value={snapshotId} onValueChange={(value) => setSnapshotId(value ?? "")}>
                <SelectTrigger id={`${provider}-snapshot`} aria-label="Setup snapshot">
                  <SelectValue>
                    {account.snapshots.find((snapshot) => snapshot.id === snapshotId)?.name ??
                      "Clean Linux machine"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="">Clean Linux machine</SelectItem>
                  {account.snapshots.map((snapshot) => (
                    <SelectItem key={snapshot.id} value={snapshot.id}>
                      {snapshot.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="w-full">
              <label htmlFor={`${provider}-repository`} className="text-sm">
                Repository HTTPS URL (optional)
              </label>
              <Input
                id={`${provider}-repository`}
                type="url"
                placeholder="https://github.com/owner/repository.git"
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
              />
            </div>
            <div className="w-full">
              <label htmlFor={`${provider}-task`} className="text-sm">
                Initial task (optional)
              </label>
              <Input
                id={`${provider}-task`}
                value={initialTask}
                maxLength={16000}
                onChange={(event) => setInitialTask(event.target.value)}
              />
            </div>
            {initialTask.trim() ? (
              <>
                <Select
                  value={agentProvider}
                  onValueChange={(value) => {
                    if (value !== "codex" && value !== "claudeAgent") return;
                    setAgentProvider(value);
                    setModel(value === "codex" ? "gpt-6-luna" : "claude-haiku-4-5");
                  }}
                >
                  <SelectTrigger aria-label="Initial task provider">
                    <SelectValue>{agentProvider === "codex" ? "Codex" : "Claude"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="codex">Codex</SelectItem>
                    <SelectItem value="claudeAgent">Claude</SelectItem>
                  </SelectPopup>
                </Select>
                <div className="min-w-40 flex-1">
                  <label htmlFor={`${provider}-model`} className="text-sm">
                    Model
                  </label>
                  <Input
                    id={`${provider}-model`}
                    value={model}
                    required
                    onChange={(event) => setModel(event.target.value)}
                  />
                </div>
                <p className="w-full text-xs text-muted-foreground">
                  The initial task uses the machine's provider sign-in and incurs agent usage.
                </p>
              </>
            ) : null}
            <Button type="submit" disabled={busy || !canPair}>
              Create and connect
            </Button>
            <p className="w-full text-xs text-muted-foreground">
              Snapshots include their saved sign-ins. Only use snapshots you trust. New machines
              keep separate T3 history.
            </p>
          </form>
          {account.machines.map((machine) => (
            <SettingsRow
              key={machine.id}
              title={machine.name}
              description={`${machine.state} · ${machine.spec.vcpus} vCPU · ${machine.spec.memMiB / 1024} GiB RAM`}
              control={
                machine.metadata?.app === "t3code" ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !canPair}
                      onClick={() => void perform({ action: "connect", machineId: machine.id })}
                    >
                      Connect
                    </Button>
                    {machine.state === "running" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !allowed}
                        onClick={() =>
                          void perform({
                            action: provider === "boat" ? "stop" : "pause",
                            machineId: machine.id,
                          })
                        }
                      >
                        {provider === "boat" ? "Stop" : "Pause"}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !allowed}
                      onClick={() => setPendingDelete({ id: machine.id, name: machine.name })}
                    >
                      Delete
                    </Button>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">Managed outside T3</span>
                )
              }
            />
          ))}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !canConfigure}
            onClick={() => void perform({ action: "disconnect" })}
          >
            Disconnect account
          </Button>
          <p className="text-xs text-muted-foreground">
            Disconnecting removes the API key. Machines keep their current state.
          </p>
        </div>
      ) : null}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the machine and its T3 history, files and running work. Saved
              snapshots remain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy || !allowed}
              onClick={() => {
                if (!pendingDelete) return;
                const machineId = pendingDelete.id;
                setPendingDelete(null);
                void perform({ action: "delete", machineId });
              }}
            >
              Delete machine
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
