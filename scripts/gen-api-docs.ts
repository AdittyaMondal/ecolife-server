/**
 * Renders `docs/api-reference.md` from `openapi.json`.
 *
 * Generated and COMMITTED, like openapi.json itself — a hand-maintained API
 * document drifts from the code within a sprint, and a drifted document is
 * worse than none because people trust it.
 *
 *   pnpm gen:apidocs            # write
 *   pnpm gen:apidocs -- --check # exit 1 if stale (CI)
 */
type Schema = Record<string, unknown>;
type Spec = {
  info: { title: string; version: string; description?: string };
  tags?: { name: string; description?: string }[];
  paths: Record<string, Record<string, Op>>;
  components: { schemas: Record<string, Schema> };
};
type Op = {
  tags?: string[];
  summary?: string;
  description?: string;
  security?: unknown[];
  parameters?: { name: string; in: string; required?: boolean; schema?: Schema }[];
  requestBody?: { required?: boolean; content: Record<string, { schema: Schema }> };
  responses: Record<string, { description?: string; content?: Record<string, { schema: Schema }> }>;
};

const SPEC = new URL('../openapi.json', import.meta.url);
const OUT = new URL('../docs/api-reference.md', import.meta.url);
const spec: Spec = await Bun.file(SPEC).json();

const refName = (s: Schema | undefined): string | null => {
  const r = s?.$ref as string | undefined;
  return r?.startsWith('#/components/schemas/') ? r.slice(21) : null;
};

/** A short, human type label. Recurses one level into arrays and unions. */
function typeLabel(s: Schema | undefined): string {
  if (!s) return '—';
  const r = refName(s);
  if (r) return `[\`${r}\`](#${r.toLowerCase()})`;
  if (Array.isArray(s.anyOf)) {
    const parts = (s.anyOf as Schema[]).map(typeLabel);
    return parts.join(' \\| ');
  }
  if (s.type === 'array') return `${typeLabel(s.items as Schema)}[]`;
  if (Array.isArray(s.enum)) return (s.enum as unknown[]).map((v) => `\`${v}\``).join(' \\| ');
  if (s.type === 'object') return 'object';
  if (s.const !== undefined) return `\`${s.const}\``;
  const t = (s.type as string) ?? 'unknown';
  return s.format ? `${t} (${s.format})` : t;
}

/** The `data` payload inside the success envelope, unwrapped. */
function dataSchema(s: Schema | undefined): Schema | undefined {
  const props = s?.properties as Record<string, Schema> | undefined;
  return props?.data;
}

function fieldTable(s: Schema | undefined, indent = ''): string[] {
  const props = s?.properties as Record<string, Schema> | undefined;
  if (!props) return [];
  const required = new Set((s?.required as string[]) ?? []);
  const rows = [`${indent}| Field | Type | Required | Notes |`, `${indent}|---|---|---|---|`];
  for (const [name, def] of Object.entries(props)) {
    const notes: string[] = [];
    if (def.description) notes.push(String(def.description));
    if (def.example !== undefined && typeof def.example !== 'object')
      notes.push(`e.g. \`${JSON.stringify(def.example)}\``);
    if (def.minimum !== undefined || def.maximum !== undefined)
      notes.push(`range ${def.minimum ?? '−∞'}…${def.maximum ?? '∞'}`);
    if (def.default !== undefined) notes.push(`default \`${JSON.stringify(def.default)}\``);
    rows.push(
      `${indent}| \`${name}\` | ${typeLabel(def)} | ${required.has(name) ? 'yes' : 'no'} | ${
        notes.join('. ').replace(/\|/g, '\\|') || ''
      } |`,
    );
  }
  return rows;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// ---- group operations by tag, honouring the spec's tag order -----------------
const byTag = new Map<string, { method: string; path: string; op: Op }[]>();
let opCount = 0;
for (const [path, ops] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(ops)) {
    opCount++;
    for (const tag of op.tags ?? ['untagged']) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)?.push({ method: method.toUpperCase(), path, op });
    }
  }
}
const tagOrder = (spec.tags ?? []).map((t) => t.name).filter((t) => byTag.has(t));
const tags = [...tagOrder, ...[...byTag.keys()].filter((t) => !tagOrder.includes(t))];
const tagDesc = new Map((spec.tags ?? []).map((t) => [t.name, t.description ?? '']));

const L: string[] = [];
const p = (...x: string[]) => L.push(...x);

p(
  '# EcoLife API reference',
  '',
  '> **Generated from `openapi.json` — do not edit by hand.**',
  '> Run `pnpm gen:apidocs` after any contract change. `pnpm gen:apidocs -- --check`',
  '> fails CI when this file is stale.',
  '',
  `**Version** ${spec.info.version} · **Base path** \`/api/v1\` · ` +
    `**${Object.keys(spec.paths).length} paths** · **${opCount} operations** · ` +
    `**${Object.keys(spec.components.schemas).length} schemas**`,
  '',
  '---',
  '',
  '## Before you read this',
  '',
  // Computed, not written out: a hardcoded count in a GENERATED file went stale
  // the first time a module landed and then contradicted the real figure two
  // lines above it.
  `**Every endpoint below is implemented.** All ${opCount} operations run against the real`,
  'database; none returns `GEN_501` any more. Point your client at the server, not',
  'at the mock — the mock serves the *examples* in this document, so it will happily',
  'return a plausible shape for a request the real server would reject.',
  '',
  '```bash',
  'cd ecolife-server && pnpm dev       # :4000, the real thing',
  'pnpm mock                           # :4010, examples only — shapes, not behaviour',
  '```',
  '',
  'Point a client at one or the other with a single env var — `NEXT_PUBLIC_API_URL`',
  'on web, `EXPO_PUBLIC_API_URL` on mobile. No code change.',
  '',
  'The mock remains useful for one thing: building a screen before the endpoint it',
  'needs exists. That is no longer the case for anything in this document.',
  '',
  '### The envelope',
  '',
  'Every response, success or failure, uses one shape:',
  '',
  '```json',
  '{ "status": true,  "data": { }, "error": null }',
  '{ "status": false, "data": null, "error": { "code": "GOAL_001", "message": "…", "details": {} } }',
  '```',
  '',
  'The tables below describe the **`data`** payload. `status` and `error` are always present.',
  '',
  '**Branch on `error.code`, never on `error.message`.** Messages are user-facing copy and',
  'will be reworded and translated; codes are stable. The registry is',
  '[`docs/error-codes.md`](./error-codes.md).',
  '',
  '### Auth',
  '',
  'Endpoints marked 🔒 require `Authorization: Bearer <accessToken>`. The access token is a',
  '15-minute JWT from `POST /auth/login`; refresh rotates it. Web keeps the refresh token in',
  'an httpOnly cookie, mobile in `expo-secure-store`, and `POST /auth/refresh` accepts either.',
  '',
  '### Conventions',
  '',
  '- All money is an integer in **paise**. No float ever touches a price.',
  '- All emissions are **kg CO₂e**, `double precision`.',
  "- Dates are `YYYY-MM-DD` and mean the **user's local date**, resolved from their timezone.",
  '- Timestamps are ISO 8601 UTC.',
  '- Lists are **keyset paginated**: `?cursor=&limit=` in, `{ items, pageInfo }` out.',
  '- Mutations accept an `Idempotency-Key` header; some take an explicit idempotency field.',
  '',
  '---',
  '',
  '## Contents',
  '',
);

for (const tag of tags) {
  const n = byTag.get(tag)?.length;
  p(
    `- [${tag}](#${slug(tag)}) — ${n} operation${n === 1 ? '' : 's'}${
      tagDesc.get(tag) ? `. ${tagDesc.get(tag)}` : ''
    }`,
  );
}
p('- [Schemas](#schemas)', '');

// ---- operations --------------------------------------------------------------
for (const tag of tags) {
  p('---', '', `## ${tag}`, '');
  if (tagDesc.get(tag)) p(`${tagDesc.get(tag)}`, '');

  const items = byTag
    .get(tag)
    ?.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  p('| | Endpoint | Summary |', '|---|---|---|');
  for (const { method, path, op } of items) {
    p(
      `| \`${method}\` | [\`${path}\`](#${slug(method + path)}) ${op.security ? '🔒' : ''} | ${(
        op.summary ?? ''
      ).replace(/\|/g, '\\|')} |`,
    );
  }
  p('');

  for (const { method, path, op } of items) {
    p(`### \`${method}\` \`${path}\``, '');
    if (op.summary) p(`**${op.summary}**`, '');
    p(op.security ? '🔒 Requires a bearer token.' : '🔓 No authentication.', '');
    if (op.description)
      p(
        op.description
          .split('\n')
          .map((l) => l.trimEnd())
          .join('\n'),
        '',
      );

    const params = op.parameters ?? [];
    if (params.length) {
      p('**Parameters**', '', '| Name | In | Required | Type | Notes |', '|---|---|---|---|---|');
      for (const prm of params) {
        const sc = prm.schema ?? {};
        const notes = [
          sc.example !== undefined ? `e.g. \`${JSON.stringify(sc.example)}\`` : '',
          sc.default !== undefined ? `default \`${JSON.stringify(sc.default)}\`` : '',
        ]
          .filter(Boolean)
          .join('. ');
        p(
          `| \`${prm.name}\` | ${prm.in} | ${prm.required ? 'yes' : 'no'} | ${typeLabel(sc)} | ${notes} |`,
        );
      }
      p('');
    }

    const body = op.requestBody?.content?.['application/json']?.schema;
    if (body) {
      const nm = refName(body);
      p(
        `**Request body**${op.requestBody?.required ? ' (required)' : ''}${
          nm ? ` — ${typeLabel(body)}` : ''
        }`,
        '',
      );
      const rows = fieldTable(nm ? (spec.components.schemas[nm] as Schema) : body);
      if (rows.length) p(...rows, '');
      else p('_See the schema._', '');
    }

    p('**Responses**', '', '| Code | Meaning | `data` |', '|---|---|---|');
    for (const [code, res] of Object.entries(op.responses)) {
      const sc = res.content?.['application/json']?.schema;
      const d = dataSchema(sc);
      p(
        `| \`${code}\` | ${(res.description ?? '').replace(/\|/g, '\\|')} | ${
          code.startsWith('2') ? typeLabel(d) : 'null'
        } |`,
      );
    }
    p('');
  }
}

// ---- schema appendix ---------------------------------------------------------
p(
  '---',
  '',
  '## Schemas',
  '',
  `${Object.keys(spec.components.schemas).length} named components.`,
  '',
);
for (const [name, sch] of Object.entries(spec.components.schemas).sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  p(`### ${name}`, '');
  if (sch.description) p(String(sch.description), '');
  if (Array.isArray(sch.enum)) {
    p(`Enum: ${(sch.enum as unknown[]).map((v) => `\`${v}\``).join(' · ')}`, '');
    continue;
  }
  const rows = fieldTable(sch);
  if (rows.length) p(...rows, '');
  else p(`\`${typeLabel(sch)}\``, '');
}

const next = `${L.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;

if (process.argv.includes('--check')) {
  const current = await Bun.file(OUT)
    .text()
    .catch(() => '');
  if (current !== next) {
    console.error('docs/api-reference.md is stale. Run `pnpm gen:apidocs` and commit it.');
    process.exit(1);
  }
  console.log('docs/api-reference.md is up to date.');
} else {
  await Bun.write(OUT, next);
  console.log(`docs/api-reference.md written — ${opCount} operations, ${L.length} lines.`);
}
