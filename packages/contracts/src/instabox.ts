import * as Schema from "effect/Schema";

const MachineId = Schema.String.check(Schema.isPattern(/^m_[a-z0-9]+$/));
const SnapshotId = Schema.String.check(Schema.isPattern(/^sn_[a-z0-9]+$/));
export const InstaboxInput = Schema.Union([
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
    action: Schema.Literals(["connect", "pause", "delete"]),
    machineId: MachineId,
  }),
]);
export type InstaboxInput = typeof InstaboxInput.Type;

export const InstaboxMachine = Schema.Struct({
  id: MachineId,
  name: Schema.String,
  state: Schema.String,
  spec: Schema.Struct({ vcpus: Schema.Number, memMiB: Schema.Number }),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export const InstaboxSnapshot = Schema.Struct({ id: SnapshotId, name: Schema.String });
export const InstaboxResult = Schema.Struct({
  configured: Schema.Boolean,
  machines: Schema.Array(InstaboxMachine),
  snapshots: Schema.Array(InstaboxSnapshot),
  pairingUrl: Schema.optionalKey(Schema.String),
});
export type InstaboxResult = typeof InstaboxResult.Type;

export class InstaboxError extends Schema.TaggedError<InstaboxError>()("InstaboxError", {
  operation: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return `Instabox ${this.operation} failed${this.status === undefined ? "" : ` (HTTP ${this.status})`}. Check the account, API key permissions and machine status, then retry.`;
  }
}
