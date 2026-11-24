import { isDeepStrictEqual } from "node:util";

/**
 * The pure three-way merge (ADR 0001). No I/O: given the Base and each Side's
 * current Invoice in the common shape, decide what to copy where.
 */

export type Line = { description: string; amountCents: number; revenueCategory: string };

/** An Invoice's synced fields, identical in shape whichever Side they came from. Derived Fields are absent. */
export type InvoiceFields = {
  docNumber: string;
  customer: string;
  txnDate: string;
  dueDate: string | null;
  memo: string | null;
  lines: Line[];
};

const FINANCIAL = ["customer", "txnDate", "lines"] as const;
const COSMETIC = ["dueDate", "memo"] as const;
/** Every field the merge compares (identity and Derived Fields aside). */
export const SYNCED_FIELDS = [...FINANCIAL, ...COSMETIC];
type Field = (typeof FINANCIAL)[number] | (typeof COSMETIC)[number];

export type Conflict = { field: Field; base: unknown; internal: unknown; qbo: unknown };

export type MergeResult =
  | { kind: "attention"; reason: string }
  | { kind: "conflict"; conflicts: Conflict[] }
  | {
      kind: "plan";
      toInternal: Partial<InvoiceFields>;
      toQbo: Partial<InvoiceFields>;
      merged: InvoiceFields;
      notes: string[];
    };

export type MergeInput = {
  base: InvoiceFields;
  internal: InvoiceFields;
  qbo: InvoiceFields;
  internalUpdatedAt: string;
  qboUpdatedAt: string;
};

// Lines compare as one unit: the Sides share no stable line ids, so line order matters
// (key order inside a line does not: the Base round-trips through jsonb, which reorders keys).
const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);

export function merge({ base, internal, qbo, internalUpdatedAt, qboUpdatedAt }: MergeInput): MergeResult {
  if (internal.docNumber !== base.docNumber || qbo.docNumber !== base.docNumber) {
    return {
      kind: "attention",
      reason: `DocNumber changed (Base ${base.docNumber}, internal ${internal.docNumber}, QBO ${qbo.docNumber}); identity is never synced`,
    };
  }

  const conflicts: Conflict[] = [];
  const toInternal: Partial<InvoiceFields> = {};
  const toQbo: Partial<InvoiceFields> = {};
  const merged: InvoiceFields = { ...base };
  const notes: string[] = [];

  for (const field of [...FINANCIAL, ...COSMETIC]) {
    const i = internal[field];
    const q = qbo[field];
    const internalChanged = !same(i, base[field]);
    const qboChanged = !same(q, base[field]);
    if (!internalChanged && !qboChanged) continue;
    if (internalChanged && qboChanged && !same(i, q)) {
      if ((FINANCIAL as readonly string[]).includes(field)) {
        conflicts.push({ field, base: base[field], internal: i, qbo: q });
        continue;
      }
      // Cosmetic: last writer wins by each Side's own clock. A tie goes to QBO, the book of record.
      const internalWins = Date.parse(internalUpdatedAt) > Date.parse(qboUpdatedAt);
      notes.push(`${field} changed on both Sides; ${internalWins ? "internal" : "QBO"} edit is newer and wins`);
      Object.assign(merged, { [field]: internalWins ? i : q });
      Object.assign(internalWins ? toQbo : toInternal, { [field]: internalWins ? i : q });
      continue;
    }
    if (internalChanged && qboChanged) {
      Object.assign(merged, { [field]: i }); // converged
    } else if (internalChanged) {
      Object.assign(merged, { [field]: i });
      Object.assign(toQbo, { [field]: i });
    } else {
      Object.assign(merged, { [field]: q });
      Object.assign(toInternal, { [field]: q });
    }
  }

  // A Conflict pauses the whole Invoice: no clean field is applied either.
  if (conflicts.length) return { kind: "conflict", conflicts };
  return { kind: "plan", toInternal, toQbo, merged, notes };
}
