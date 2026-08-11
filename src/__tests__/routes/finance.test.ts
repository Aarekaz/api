import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/env";
import financeRoute from "../../routes/finance";

function createDb(row?: Record<string, unknown>) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
  const db = {
    prepare(sql: string) {
      return {
        all: vi.fn().mockResolvedValue({ results: row ? [row] : [] }),
        bind(...bindings: unknown[]) {
          calls.push({ sql, bindings });
          return { run };
        },
      };
    },
  };

  return { db: db as unknown as D1Database, calls, run };
}

describe("finance route", () => {
  it("returns the default finance plan when no row exists", async () => {
    const { db } = createDb();
    const res = await financeRoute.request("/", {}, { DB: db } as Env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      offer?: { annual_salary?: number; annual_equity_value?: number };
      budget?: {
        hsa_coverage?: string;
        employer_401k_match_rate_percent?: number;
        loan_balance?: number;
        investment_label?: string;
        hysa_apy_percent?: number;
        cash_savings_balance?: number;
        current_hysa_balance?: number;
        accounts?: unknown[];
        money_routes?: unknown[];
        items?: unknown[];
      };
    };
    expect(body.offer?.annual_salary).toBe(150000);
    expect(body.offer?.annual_equity_value).toBe(0);
    expect(body.budget?.hsa_coverage).toBe("self");
    expect(body.budget?.employer_401k_match_rate_percent).toBe(100);
    expect(body.budget?.loan_balance).toBe(0);
    expect(body.budget?.investment_label).toBe("S&P 500");
    expect(body.budget?.hysa_apy_percent).toBe(4);
    expect(body.budget?.cash_savings_balance).toBe(0);
    expect(body.budget?.current_hysa_balance).toBe(0);
    expect(body.budget?.accounts).toHaveLength(3);
    expect(body.budget?.money_routes).toHaveLength(0);
    expect(body.budget?.items).toHaveLength(5);
  });

  it("normalizes stored JSON fields from D1", async () => {
    const { db } = createDb({
      id: 1,
      offer_json: JSON.stringify({ annual_salary: 200000, annual_equity_value: 50000 }),
      budget_json: JSON.stringify({ monthly_gross_income: 16667, items: [] }),
      equity_json: JSON.stringify([{ id: "grant-1", shares: 1000 }]),
      notes: "review option grant",
      created_at: "2026-06-18T00:00:00.000Z",
      updated_at: "2026-06-18T00:00:00.000Z",
    });
    const res = await financeRoute.request("/", {}, { DB: db } as Env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      offer?: { annual_salary?: number; annual_equity_value?: number };
      equity?: Array<{ id: string; shares: number }>;
      notes?: string;
    };
    expect(body.offer?.annual_salary).toBe(200000);
    expect(body.offer?.annual_equity_value).toBe(50000);
    expect(body.equity?.[0]).toEqual({ id: "grant-1", shares: 1000 });
    expect(body.notes).toBe("review option grant");
  });

  it("persists a valid finance plan", async () => {
    const { db, calls, run } = createDb();
    const payload = {
      offer: {
        annual_salary: 175000,
        annual_bonus_target: 15000,
        annual_equity_value: 30000,
        signing_bonus: 10000,
        relocation_bonus: 5000,
      },
      budget: {
        monthly_gross_income: 15833,
        retirement_401k_percent: 5,
        retirement_401k_traditional_percent: 3,
        retirement_401k_roth_percent: 2,
        hsa_monthly: 366,
        hsa_coverage: "family",
        hsa_employer_monthly: 100,
        employer_401k_match_rate_percent: 100,
        employer_401k_match_limit_percent: 4,
        expected_annual_return_percent: 7,
        growth_years: 30,
        marginal_tax_rate_percent: 30,
        loan_balance: 12000,
        loan_payment_monthly: 600,
        loan_interest_rate_percent: 6.5,
        investment_label: "S&P 500",
        investment_monthly: 1000,
        investment_return_percent: 7,
        hysa_monthly: 500,
        hysa_apy_percent: 4.25,
        cash_savings_balance: 5000,
        current_hysa_balance: 10000,
        current_401k_balance: 12000,
        current_hsa_balance: 800,
        current_investment_balance: 3000,
        other_assets_balance: 1500,
        accounts: [
          { id: "checking", name: "Checking", type: "checking", monthly_deposit: 9000 },
          { id: "hysa", name: "HYSA", type: "hysa", monthly_deposit: 500 },
        ],
        money_routes: [
          { id: "route-rent", account_id: "checking", target_key: "budget:rent", amount: 2500, paycheck_index: 1 },
          { id: "route-hysa", account_id: "hysa", target_key: "hysa", amount: 500, paycheck_index: 2 },
        ],
        money_map_positions: {
          "paycheck:1": { x: 280, y: 140 },
          "account:hysa": { x: 540, y: 260 },
        },
        items: [{ id: "rent", name: "Rent", kind: "spending", amount: 2500 }],
      },
      equity: [{ id: "grant-1", grant_type: "options", shares: 10000 }],
      notes: "signed offer",
    };

    const res = await financeRoute.request(
      "/",
      { method: "PUT", body: JSON.stringify(payload) },
      { DB: db } as Env
    );

    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("INSERT INTO finance_plan");
    expect(JSON.parse(calls[0].bindings[0] as string)).toEqual(payload.offer);
    expect(JSON.parse(calls[0].bindings[1] as string)).toEqual(payload.budget);
    expect(JSON.parse(calls[0].bindings[2] as string)).toEqual(payload.equity);
    expect(calls[0].bindings[3]).toBe("signed offer");
  });

  it("rejects invalid negative finance values", async () => {
    const { db } = createDb();
    const res = await financeRoute.request(
      "/",
      {
        method: "PUT",
        body: JSON.stringify({ offer: { annual_salary: -1 } }),
      },
      { DB: db } as Env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Validation error");
  });
});
