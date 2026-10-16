import { MCP_TRANSPORTS } from "@shared/constants/mcp";
import { t } from "@shared/l10n";
import type { McpConfig, McpTransport } from "@shared/types";
import { Field } from "../../../field";
import { Input } from "../../../input";
import { Select } from "../../../select";
import { Textarea } from "../../../textarea";

/**
 * Transport-aware MCP config form (shared by detail + add modal).
 * stdio → command / args / env (KEY=value lines);
 * http (streamable HTTP) → url / headers (KEY=value lines).
 */

export interface McpConfigFormValue {
  transport: McpTransport;
  command: string;
  args: string;
  url: string;
  /** Raw "KEY=value" lines (env or headers, per transport). */
  kv: string;
}

export function configToForm(config: McpConfig): McpConfigFormValue {
  if (config.transport === "stdio") {
    return {
      transport: "stdio",
      command: config.command,
      args: config.args,
      url: "",
      kv: recordToLines(config.env),
    };
  }
  return {
    transport: config.transport,
    command: "",
    args: "",
    url: config.url,
    kv: recordToLines(config.headers),
  };
}

export function formToConfig(form: McpConfigFormValue): McpConfig {
  if (form.transport === "stdio") {
    return {
      transport: "stdio",
      command: form.command.trim(),
      args: form.args,
      env: linesToRecord(form.kv),
    };
  }
  return {
    transport: form.transport,
    url: form.url.trim(),
    headers: linesToRecord(form.kv),
  };
}

function recordToLines(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/** Parse "KEY=value" lines; keys are validated further in the main process. */
export function linesToRecord(lines: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Permissive so HTTP header names (e.g. `X-Api-Key`) survive; the `mcp.json`
  // store rejects env keys that are not env-var shaped.
  const KEY_RE = /^[A-Za-z0-9_.-]+$/;
  for (const rawLine of lines.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key) || key.length > 256) continue;
    result[key] = line.slice(eq + 1).trim();
  }
  return result;
}

export interface McpConfigFieldsProps {
  value: McpConfigFormValue;
  onChange: (value: McpConfigFormValue) => void;
  idPrefix: string;
}

export function McpConfigFields({
  value,
  onChange,
  idPrefix,
}: McpConfigFieldsProps): React.JSX.Element {
  const set = (patch: Partial<McpConfigFormValue>): void =>
    onChange({ ...value, ...patch });

  return (
    <>
      <Field label={t("Transport")} htmlFor={`${idPrefix}-transport`}>
        <Select
          id={`${idPrefix}-transport`}
          value={value.transport}
          options={MCP_TRANSPORTS.map((transport) => ({
            value: transport,
            label: transport,
          }))}
          onChange={(next) => set({ transport: next as McpTransport, kv: "" })}
        />
      </Field>

      {value.transport === "stdio" ? (
        <>
          <Field
            label={t("Command")}
            hint={t("The executable's name, e.g. npx, node, python")}
            htmlFor={`${idPrefix}-command`}
          >
            <Input
              id={`${idPrefix}-command`}
              mono
              value={value.command}
              placeholder={t("e.g. npx, node, python")}
              onChange={(e) => set({ command: e.target.value })}
            />
          </Field>
          <Field label={t("Arguments")} htmlFor={`${idPrefix}-args`}>
            <Textarea
              id={`${idPrefix}-args`}
              mono
              value={value.args}
              placeholder="-y @modelcontextprotocol/server-xxx"
              minHeight={72}
              onChange={(e) => set({ args: e.target.value })}
            />
          </Field>
          <Field
            label={t("Environment variables")}
            hint={t("One KEY=value per line")}
            htmlFor={`${idPrefix}-env`}
          >
            <Textarea
              id={`${idPrefix}-env`}
              mono
              value={value.kv}
              placeholder={t("KEY=value")}
              minHeight={72}
              onChange={(e) => set({ kv: e.target.value })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label={t("Server URL")} htmlFor={`${idPrefix}-url`}>
            <Input
              id={`${idPrefix}-url`}
              mono
              value={value.url}
              placeholder={t("https://mcp.example.com/mcp")}
              onChange={(e) => set({ url: e.target.value })}
            />
          </Field>
          <Field
            label={t("Headers")}
            hint={t("One KEY=value per line")}
            htmlFor={`${idPrefix}-headers`}
          >
            <Textarea
              id={`${idPrefix}-headers`}
              mono
              value={value.kv}
              placeholder={t("Authorization=Bearer xxx")}
              minHeight={72}
              onChange={(e) => set({ kv: e.target.value })}
            />
          </Field>
        </>
      )}
    </>
  );
}
