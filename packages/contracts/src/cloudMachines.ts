import * as Schema from "effect/Schema";

const MachineId = Schema.String.check(
  Schema.isPattern(/^(?:m_[a-z0-9]+|bx_[23456789abcdefghjkmnpqrstuvwxyz]{8})$/),
);
const SnapshotId = Schema.String.check(
  Schema.isPattern(/^(?:sn_[a-z0-9]+|[a-z0-9][a-z0-9-]{0,62})$/),
);
export const CloudMachineInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("configure"),
    apiKey: Schema.RedactedFromValue(Schema.String),
  }),
  Schema.Struct({ action: Schema.Literal("disconnect") }),
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({
    action: Schema.Literal("create"),
    name: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/)),
    snapshotId: Schema.optionalKey(SnapshotId),
    repositoryUrl: Schema.optionalKey(
      Schema.String.check(
        Schema.isPattern(/^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?\/[a-zA-Z0-9._~/-]+$/),
      ),
    ),
    initialTask: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16000))),
    provider: Schema.optionalKey(Schema.Literals(["codex", "claudeAgent"])),
    model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  }),
  Schema.Struct({
    action: Schema.Literals(["connect", "pause", "stop", "delete"]),
    machineId: MachineId,
  }),
]);
export type CloudMachineInput = typeof CloudMachineInput.Type;

export const CloudMachine = Schema.Struct({
  id: MachineId,
  name: Schema.String,
  state: Schema.String,
  spec: Schema.Struct({ vcpus: Schema.Number, memMiB: Schema.Number }),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export const CloudSnapshot = Schema.Struct({ id: SnapshotId, name: Schema.String });
export const CloudSetupWarning = Schema.Literals(["repository", "project", "task"]);
export const CloudMachineResult = Schema.Struct({
  configured: Schema.Boolean,
  machines: Schema.Array(CloudMachine),
  snapshots: Schema.Array(CloudSnapshot),
  pairingUrl: Schema.optionalKey(Schema.String),
  setupWarning: Schema.optionalKey(CloudSetupWarning),
  deletionPending: Schema.optionalKey(Schema.Boolean),
});
export type CloudMachineResult = typeof CloudMachineResult.Type;

export class CloudMachineError extends Schema.TaggedError<CloudMachineError>()(
  "CloudMachineError",
  {
    operation: Schema.String,
    status: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Cloud ${this.operation} failed${this.status === undefined ? "" : ` (HTTP ${this.status})`}. Check the account, API key permissions and machine status, then retry.`;
  }
}
