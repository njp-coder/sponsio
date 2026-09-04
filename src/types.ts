/** A loose JSON Schema view — only the keywords that affect an agent's ability to call a tool. */
export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JsonSchema;
  [keyword: string]: unknown;
}

/**
 * Safety hints a tool declares about itself.
 *
 * The wire protocol and the JS API disagree on names (`readOnly` over CDP,
 * `readOnlyHint` in page script); both are normalized to these fields.
 */
export interface ToolAnnotations {
  readOnly?: boolean;
  untrustedContent?: boolean;
  consequential?: boolean;
  autosubmit?: boolean;
}

export interface ToolRecord {
  name: string;
  description: string;
  inputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  /** Declarative tools are synthesized by the browser from annotated HTML forms. */
  kind: "imperative" | "declarative";
}

export interface Snapshot {
  sponsio: 1;
  url: string;
  capturedAt: string;
  userAgent?: string;
  tools: ToolRecord[];
}

export type Severity = "breaking" | "warning" | "safe";

export interface Finding {
  severity: Severity;
  /** Stable machine-readable code, e.g. `REQUIRED_ADDED`. */
  code: string;
  tool: string;
  /** Dotted path into the input schema, when the finding is about one field. */
  path?: string;
  message: string;
}

export interface DiffResult {
  findings: Finding[];
  counts: Record<Severity, number>;
  /** True when nothing at all changed. */
  clean: boolean;
}
