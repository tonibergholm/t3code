import { AuthStandardClientScopes, type CloudMachineInput } from "@t3tools/contracts";

// A separate data directory prevents snapshots from duplicating T3's environment identity.
export const CLOUD_BOOTSTRAP = `set -eu
export PATH="$HOME/.local/bin:$PATH"
export GIT_TERMINAL_PROMPT=0
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
setup_warning=
if [ -n "$2" ] && [ ! -d "$T3CODE_HOME/repository/.git" ]; then
  if ! git clone -- "$2" "$T3CODE_HOME/repository"; then setup_warning=repository; fi
fi
if [ -d "$T3CODE_HOME/repository/.git" ]; then
  cd "$T3CODE_HOME/repository"
else
  cd "$T3CODE_HOME/workspace"
fi
t3 up --lan --no-connect --yes --headless >/dev/null
curl --fail --silent --show-error --retry 15 --retry-connrefused --retry-delay 1 \
  http://127.0.0.1:3773/.well-known/t3/environment >/dev/null
if [ -z "$setup_warning" ] && [ ! -f "$T3CODE_HOME/.project-added" ]; then
  if t3 project add "$PWD" >/dev/null; then
    touch "$T3CODE_HOME/.project-added"
  else
    setup_warning=project
  fi
fi
if [ -z "$setup_warning" ] && [ -n "$3" ] && [ ! -f "$T3CODE_HOME/.thread-started" ]; then
  if t3 thread start --provider "$4" --model "$5" -- "$PWD" "$3" >/dev/null; then
    touch "$T3CODE_HOME/.thread-started"
  else
    setup_warning=task
  fi
fi
t3 pair --base-dir "$T3CODE_HOME" ${AuthStandardClientScopes.map((scope) => `--scope ${scope}`).join(" ")}
if [ -n "$setup_warning" ]; then printf 'T3_SETUP_WARNING=%s\\n' "$setup_warning"; fi
`;

export function cloudPairingUrl(output: string, endpoint: string): string {
  const match = /^Pairing URL: (https?:\/\/\S+)$/m.exec(output);
  if (!match?.[1]) throw new Error("Missing T3 pairing URL");
  const pairing = new URL(match[1]);
  const target = new URL(endpoint);
  if (target.protocol !== "https:") throw new Error("Invalid cloud endpoint");
  target.pathname = pairing.pathname;
  target.search = pairing.search;
  target.hash = pairing.hash;
  return target.toString();
}

export function boatBootstrapCommand(
  machineId: string,
  setup?: Extract<CloudMachineInput, { action: "create" }>,
): string {
  return [
    "bash",
    "-lc",
    // Boat injects agent variables into shells; the background service reads service.env instead.
    `set -eu
export PATH="$HOME/.local/bin:$PATH"
export T3CODE_HOME="$HOME/.t3-cloud/$1"
umask 077
mkdir -p "$T3CODE_HOME"
credentials_changed=$(node --input-type=module <<'T3_PROVIDER_ENV'
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { parseEnv } from 'node:util';
const file = process.env.T3CODE_HOME + '/service.env';
const previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
const entries = parseEnv(previous);
let changed = false;
for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CHATGPT_ACCOUNT_ID']) {
  const value = process.env[name] || undefined;
  if (entries[name] !== value) changed = true;
  if (value === undefined) delete entries[name];
  else entries[name] = value;
}
const next = Object.entries(entries).map(([name, value]) => {
  const quoted = ["'", String.fromCharCode(96), '"'].map(q => q + value + q)
    .find(candidate => parseEnv('VALUE=' + candidate).VALUE === value);
  if (quoted === undefined) throw new Error('Cannot encode service environment');
  return name + '=' + quoted;
}).join('\\n') + '\\n';
if (changed) {
  writeFileSync(file + '.previous', previous, { mode: 0o600 });
  if (existsSync(file)) chmodSync(file, 0o600);
  writeFileSync(file, next, { mode: 0o600 });
}
console.log(changed);
T3_PROVIDER_ENV
)
if [ "$credentials_changed" = true ] && [ -f "$T3CODE_HOME/.installed" ]; then
  if ! t3 service restart >/dev/null; then
    mv "$T3CODE_HOME/service.env.previous" "$T3CODE_HOME/service.env"
    exit 1
  fi
fi
rm -f "$T3CODE_HOME/service.env.previous"
${CLOUD_BOOTSTRAP}`,
    "t3-cloud",
    machineId,
    setup?.repositoryUrl ?? "",
    setup?.initialTask ?? "",
    setup?.provider ?? "codex",
    setup?.model ?? "gpt-6-luna",
  ]
    .map((argument) => `'${argument.replaceAll("'", `'\\''`)}'`)
    .join(" ");
}
