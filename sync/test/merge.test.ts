import { describe, expect, it } from "vitest";
import { merge, type InvoiceFields } from "../src/merge.ts";

const base: InvoiceFields = {
  docNumber: "INV-1",
  customer: "Acme Ltd",
  txnDate: "2026-11-01",
  dueDate: "2026-12-01",
  memo: "Thanks",
  lines: [{ description: "Consulting", amountCents: 10000, revenueCategory: "consulting" }],
};
const newLines = [{ description: "Consulting", amountCents: 12000, revenueCategory: "consulting" }];
const otherLines = [{ description: "Hosting", amountCents: 500, revenueCategory: "hosting" }];
const older = "2026-11-10T10:00:00.000Z";
const newer = "2026-11-10T11:00:00.000Z";

type Case = {
  name: string;
  internal?: Partial<InvoiceFields> & Record<string, unknown>;
  qbo?: Partial<InvoiceFields> & Record<string, unknown>;
  internalUpdatedAt?: string;
  qboUpdatedAt?: string;
  expected: unknown;
};

const cases: Case[] = [
  {
    name: "nothing changed: no writes",
    expected: { kind: "plan", toInternal: {}, toQbo: {}, merged: base },
  },
  {
    name: "changed internally only: copied to QBO",
    internal: { memo: "Paid by wire" },
    expected: { kind: "plan", toInternal: {}, toQbo: { memo: "Paid by wire" }, merged: { ...base, memo: "Paid by wire" } },
  },
  {
    name: "changed in QBO only: copied internally",
    qbo: { lines: newLines, customer: "Globex" },
    expected: {
      kind: "plan",
      toInternal: { lines: newLines, customer: "Globex" },
      toQbo: {},
      merged: { ...base, lines: newLines, customer: "Globex" },
    },
  },
  {
    name: "changed on both Sides to the same value: converges silently",
    internal: { lines: newLines, dueDate: null },
    qbo: { lines: newLines, dueDate: null },
    expected: { kind: "plan", toInternal: {}, toQbo: {}, merged: { ...base, lines: newLines, dueDate: null } },
  },
  {
    name: "QBO memo edit and internal line edit both survive",
    internal: { lines: newLines },
    qbo: { memo: "Net 30" },
    expected: {
      kind: "plan",
      toInternal: { memo: "Net 30" },
      toQbo: { lines: newLines },
      merged: { ...base, lines: newLines, memo: "Net 30" },
    },
  },
  {
    name: "Cosmetic Field changed differently on both: the later internal edit wins",
    internal: { memo: "internal" },
    qbo: { memo: "qbo" },
    internalUpdatedAt: newer,
    qboUpdatedAt: older,
    expected: { kind: "plan", toInternal: {}, toQbo: { memo: "internal" }, merged: { ...base, memo: "internal" } },
  },
  {
    name: "Cosmetic Field changed differently on both: the later QBO edit wins",
    internal: { dueDate: "2027-01-01" },
    qbo: { dueDate: "2027-02-01" },
    internalUpdatedAt: older,
    qboUpdatedAt: newer,
    expected: { kind: "plan", toInternal: { dueDate: "2027-02-01" }, toQbo: {}, merged: { ...base, dueDate: "2027-02-01" } },
  },
  {
    name: "Identity Field changed: Needs Attention, nothing synced",
    qbo: { docNumber: "INV-1-B", memo: "x" },
    expected: { kind: "attention", reason: expect.stringContaining("DocNumber") },
  },
  {
    name: "Derived Fields are never compared",
    internal: { totalCents: 99, paymentStatus: "paid" },
    qbo: { TotalAmt: 1, Balance: 0 },
    expected: { kind: "plan", toInternal: {}, toQbo: {}, merged: base },
  },
  {
    name: "Financial Field changed differently on both: Conflict, even with clean fields",
    internal: { lines: newLines, memo: "clean internal edit" },
    qbo: { lines: otherLines, txnDate: "2026-11-02" },
    expected: {
      kind: "conflict",
      conflicts: [{ field: "lines", base: base.lines, internal: newLines, qbo: otherLines }],
    },
  },
  {
    name: "Financial collisions are all reported",
    internal: { customer: "Globex", txnDate: "2026-10-31" },
    qbo: { customer: "Initech", txnDate: "2026-11-02" },
    expected: {
      kind: "conflict",
      conflicts: [
        { field: "customer", base: "Acme Ltd", internal: "Globex", qbo: "Initech" },
        { field: "txnDate", base: "2026-11-01", internal: "2026-10-31", qbo: "2026-11-02" },
      ],
    },
  },
];

describe("merge", () => {
  it("ignores key order inside values (the Base round-trips through jsonb)", () => {
    const reordered = { ...base, lines: [{ revenueCategory: "consulting", amountCents: 10000, description: "Consulting" }] };
    const qbo = { ...base, lines: newLines };
    const result = merge({ base: reordered, internal: base, qbo, internalUpdatedAt: older, qboUpdatedAt: older });
    expect(result).toMatchObject({ kind: "plan", toInternal: { lines: newLines }, toQbo: {} });
  });

  it.each(cases)("$name", (c) => {
    const result = merge({
      base,
      internal: { ...base, ...c.internal } as InvoiceFields,
      qbo: { ...base, ...c.qbo } as InvoiceFields,
      internalUpdatedAt: c.internalUpdatedAt ?? older,
      qboUpdatedAt: c.qboUpdatedAt ?? older,
    });
    expect(result).toMatchObject(c.expected as object);
    if (result.kind === "plan") expect(result.merged).toEqual((c.expected as any).merged);
  });
});
