import { Hono } from "hono";
import type { Env } from "../types/env";
import type { JsonRecord } from "../types/common";
import { nowIso } from "../utils/date";
import { parseJson, mapJsonField } from "../utils/json";
import { validateBody } from "../utils/validation";
import { normalizeFinancePlan } from "../utils/normalizers";
import { financePlanSchema } from "../schemas/finance";
import {
  openApiRegistry,
  genericObjectSchema,
  okUpdatedSchema,
  openApiJsonRequestBody,
  okResponses,
  authSecurity,
} from "../schemas/openapi";

const app = new Hono<{ Bindings: Env }>();

const defaultFinancePlan = {
  offer: {
    company: "",
    role: "",
    location: "",
    annual_salary: 150000,
    signing_bonus: 0,
    annual_bonus_target: 0,
    annual_equity_value: 0,
    relocation_bonus: 0,
    pay_frequency: "monthly",
  },
  budget: {
    monthly_gross_income: 12500,
    retirement_401k_percent: 4,
    retirement_401k_traditional_percent: 2,
    retirement_401k_roth_percent: 2,
    hsa_monthly: 366,
    hsa_coverage: "self",
    hsa_employer_monthly: 0,
    employer_401k_match_rate_percent: 100,
    employer_401k_match_limit_percent: 4,
    expected_annual_return_percent: 7,
    growth_years: 30,
    marginal_tax_rate_percent: 30,
    loan_balance: 0,
    loan_payment_monthly: 0,
    loan_interest_rate_percent: 0,
    investment_label: "S&P 500",
    investment_monthly: 0,
    investment_return_percent: 7,
    hysa_monthly: 0,
    hysa_apy_percent: 4,
    cash_savings_balance: 0,
    current_hysa_balance: 0,
    current_401k_balance: 0,
    current_hsa_balance: 0,
    current_investment_balance: 0,
    other_assets_balance: 0,
    accounts: [
      { id: "checking", name: "Checking", type: "checking", institution: "", monthly_deposit: 0, current_balance: 0, color: "#0f766e" },
      { id: "hysa", name: "HYSA", type: "hysa", institution: "", monthly_deposit: 0, current_balance: 0, color: "#0891b2" },
      { id: "investment", name: "Investment", type: "investment", institution: "", monthly_deposit: 0, current_balance: 0, color: "#2563eb" },
    ],
    money_routes: [],
    items: [
      { id: "federal-tax", name: "Federal Tax", kind: "tax", amount: 2094, color: "#64748b" },
      { id: "state-tax", name: "State Tax", kind: "tax", amount: 669, color: "#94a3b8" },
      { id: "rent", name: "Rent", kind: "spending", amount: 2300, color: "#0f766e" },
      { id: "food", name: "Food & Dining", kind: "spending", amount: 700, color: "#b45309" },
      { id: "fun", name: "Fun & Hobbies", kind: "spending", amount: 400, color: "#7c3aed" },
    ],
  },
  equity: [],
  notes: "",
};

openApiRegistry.registerPath({
  method: "get",
  path: "/v1/finance",
  summary: "Fetch finance plan",
  security: authSecurity,
  responses: okResponses(genericObjectSchema),
});

openApiRegistry.registerPath({
  method: "put",
  path: "/v1/finance",
  summary: "Update finance plan",
  security: authSecurity,
  request: { body: openApiJsonRequestBody(financePlanSchema) },
  responses: okResponses(okUpdatedSchema),
});

app.get("/", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM finance_plan WHERE id = 1").all();
  if (!row.results[0]) {
    return c.json(defaultFinancePlan);
  }
  return c.json(normalizeFinancePlan(row.results[0] as JsonRecord));
});

app.put("/", async (c) => {
  const body = await parseJson(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBody(financePlanSchema, body);
  if (!validation.ok) {
    return validation.response;
  }

  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO finance_plan (id, offer_json, budget_json, equity_json, notes, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       offer_json = excluded.offer_json,
       budget_json = excluded.budget_json,
       equity_json = excluded.equity_json,
       notes = excluded.notes,
       updated_at = excluded.updated_at`
  )
    .bind(
      mapJsonField(validation.data.offer ?? defaultFinancePlan.offer),
      mapJsonField(validation.data.budget ?? defaultFinancePlan.budget),
      mapJsonField(validation.data.equity ?? []),
      validation.data.notes ?? "",
      now,
      now
    )
    .run();

  return c.json({ ok: true, updated_at: now });
});

export default app;
