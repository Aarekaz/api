import { z } from "zod";
import "./openapi";
import { dateString } from "./common";

// Request schemas only (GET /v1/finance answers a generic object): the descriptions are for whoever writes the plan.

const budgetKindSchema = z.enum(["pretax", "tax", "spending", "saving"]);

export const financeOfferSchema = z.object({
  company: z.string().optional().openapi({ description: "Employer" }),
  role: z.string().optional().openapi({ description: "Job title" }),
  location: z.string().optional().openapi({ description: "Where the job is" }),
  start_date: dateString.optional().openapi({ description: "First day, YYYY-MM-DD" }),
  annual_salary: z.number().min(0).optional().openapi({ description: "Base salary a year, before tax" }),
  signing_bonus: z.number().min(0).optional().openapi({ description: "One-time, dollars" }),
  annual_bonus_target: z.number().min(0).optional().openapi({ description: "Target bonus a year, dollars" }),
  annual_equity_value: z.number().min(0).optional().openapi({ description: "Equity a year at grant value, dollars" }),
  relocation_bonus: z.number().min(0).optional().openapi({ description: "One-time, dollars" }),
  pay_frequency: z.enum(["monthly", "semimonthly", "biweekly"]).optional().openapi({ description: "How often you are paid" }),
  notes: z.string().optional().openapi({ description: "Anything about the offer" }),
});

export const financeBudgetItemSchema = z.object({
  id: z.string().min(1).openapi({ description: "Your short id; keep it when editing" }),
  name: z.string().min(1).openapi({ description: "What it is: \"Rent\", \"Federal Tax\"" }),
  kind: budgetKindSchema.openapi({ description: "pretax (out before tax), tax, spending or saving" }),
  amount: z.number().min(0).openapi({ description: "Dollars a month" }),
  color: z.string().optional().openapi({ description: "Hex colour for charts, like #0f766e" }),
});

export const financeAccountSchema = z.object({
  id: z.string().min(1).openapi({ description: "Your short id; money_routes point at it" }),
  name: z.string().min(1).openapi({ description: "What you call it" }),
  type: z.enum(["checking", "savings", "hysa", "credit", "investment", "loan", "payroll", "pretax", "other"]).openapi({ description: "The kind of account" }),
  institution: z.string().optional().openapi({ description: "Bank or broker" }),
  monthly_deposit: z.number().min(0).optional().openapi({ description: "Dollars a month into it" }),
  current_balance: z.number().min(0).optional().openapi({ description: "Dollars in it now" }),
  color: z.string().optional().openapi({ description: "Hex colour for charts" }),
});

export const financeMoneyRouteSchema = z.object({
  id: z.string().min(1).openapi({ description: "Your short id" }),
  account_id: z.string().min(1).openapi({ description: "The account the money is paid from (an accounts id)" }),
  target_key: z.string().min(1).openapi({ description: "What it pays for: \"budget:<item id>\", \"loan\", \"hysa\", \"investment\" or \"available\"" }),
  amount: z.number().min(0).openapi({ description: "Dollars a month" }),
});

export const financeMoneyMapPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const financeBudgetSchema = z.object({
  monthly_gross_income: z.number().min(0).optional().openapi({ description: "Pay a month before anything comes out" }),
  retirement_401k_percent: z.number().min(0).max(100).optional().openapi({ description: "Of gross pay into the 401(k)" }),
  hsa_monthly: z.number().min(0).optional().openapi({ description: "Your HSA contribution, dollars a month" }),
  hsa_coverage: z.enum(["self", "family"]).optional().openapi({ description: "HSA coverage, which sets its yearly limit" }),
  hsa_employer_monthly: z.number().min(0).optional().openapi({ description: "Employer HSA contribution, dollars a month" }),
  employer_401k_match_rate_percent: z.number().min(0).max(200).optional().openapi({ description: "How much the employer matches per dollar you put in, as a percent (100 = dollar for dollar)" }),
  employer_401k_match_limit_percent: z.number().min(0).max(100).optional().openapi({ description: "Matched up to this percent of your pay" }),
  expected_annual_return_percent: z.number().min(0).max(30).optional().openapi({ description: "For growth projections" }),
  growth_years: z.number().int().min(1).max(60).optional().openapi({ description: "How many years to project" }),
  marginal_tax_rate_percent: z.number().min(0).max(60).optional().openapi({ description: "Your top tax rate, for pre-tax savings" }),
  loan_balance: z.number().min(0).optional().openapi({ description: "Dollars owed" }),
  loan_payment_monthly: z.number().min(0).optional().openapi({ description: "Dollars a month" }),
  loan_interest_rate_percent: z.number().min(0).max(100).optional().openapi({ description: "Yearly rate" }),
  investment_label: z.string().optional().openapi({ description: "What the investing goes into: \"S&P 500\"" }),
  investment_monthly: z.number().min(0).optional().openapi({ description: "Dollars a month invested" }),
  investment_return_percent: z.number().min(0).max(30).optional().openapi({ description: "Expected yearly return" }),
  hysa_monthly: z.number().min(0).optional().openapi({ description: "Dollars a month into savings" }),
  hysa_apy_percent: z.number().min(0).max(30).optional().openapi({ description: "Savings rate a year" }),
  cash_savings_balance: z.number().min(0).optional().openapi({ description: "Cash on hand, dollars" }),
  current_hysa_balance: z.number().min(0).optional().openapi({ description: "Dollars now" }),
  current_401k_balance: z.number().min(0).optional().openapi({ description: "Dollars now" }),
  current_hsa_balance: z.number().min(0).optional().openapi({ description: "Dollars now" }),
  current_investment_balance: z.number().min(0).optional().openapi({ description: "Dollars now" }),
  other_assets_balance: z.number().min(0).optional().openapi({ description: "Anything else you own, dollars" }),
  accounts: z.array(financeAccountSchema).optional().openapi({ description: "Where money is kept" }),
  money_routes: z.array(financeMoneyRouteSchema).optional().openapi({ description: "Where each paycheck goes: an amount from an account to what it pays for" }),
  money_map_positions: z.record(financeMoneyMapPositionSchema).optional().openapi({ description: "Where each box sits on the dashboard's money map, by its id. Layout only; keep what GET returns" }),
  items: z.array(financeBudgetItemSchema).optional().openapi({ description: "Monthly lines: pre-tax, tax, spending and saving" }),
});

export const financeEquityGrantSchema = z.object({
  id: z.string().min(1).openapi({ description: "Your short id" }),
  company: z.string().optional().openapi({ description: "Who granted it" }),
  label: z.string().optional().openapi({ description: "A name for the grant" }),
  grant_type: z.enum(["iso", "nso", "rsu", "options", "other"]).optional().openapi({ description: "The kind of grant" }),
  shares: z.number().min(0).optional().openapi({ description: "Shares granted" }),
  strike_price: z.number().min(0).optional().openapi({ description: "Dollars a share (options)" }),
  current_fmv: z.number().min(0).optional().openapi({ description: "Fair market value now, dollars a share" }),
  vested_shares: z.number().min(0).optional().openapi({ description: "Shares vested so far" }),
  exercised_shares: z.number().min(0).optional().openapi({ description: "Shares exercised so far" }),
  vesting_start: dateString.optional().openapi({ description: "YYYY-MM-DD" }),
  vesting_months: z.number().int().positive().optional().openapi({ description: "Months to vest fully" }),
  cliff_months: z.number().int().min(0).optional().openapi({ description: "Months before the first vest" }),
  notes: z.string().optional().openapi({ description: "Anything about the grant" }),
});

export const financePlanSchema = z.object({
  offer: financeOfferSchema.optional().openapi({ description: "The job offer. Left out, it goes back to the default offer" }),
  budget: financeBudgetSchema.optional().openapi({ description: "The monthly budget. Left out, it goes back to the default budget" }),
  equity: z.array(financeEquityGrantSchema).optional().openapi({ description: "Equity grants. Left out, none" }),
  notes: z.string().optional().openapi({ description: "Your notes on the plan. Left out, empty" }),
});
