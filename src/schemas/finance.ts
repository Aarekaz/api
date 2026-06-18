import { z } from "zod";
import { dateString } from "./common";

const budgetKindSchema = z.enum(["pretax", "tax", "spending", "saving"]);

export const financeOfferSchema = z.object({
  company: z.string().optional(),
  role: z.string().optional(),
  location: z.string().optional(),
  start_date: dateString.optional(),
  annual_salary: z.number().min(0).optional(),
  signing_bonus: z.number().min(0).optional(),
  annual_bonus_target: z.number().min(0).optional(),
  annual_equity_value: z.number().min(0).optional(),
  relocation_bonus: z.number().min(0).optional(),
  pay_frequency: z.enum(["monthly", "semimonthly", "biweekly"]).optional(),
  notes: z.string().optional(),
});

export const financeBudgetItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: budgetKindSchema,
  amount: z.number().min(0),
  color: z.string().optional(),
});

export const financeBudgetSchema = z.object({
  monthly_gross_income: z.number().min(0).optional(),
  retirement_401k_percent: z.number().min(0).max(100).optional(),
  hsa_monthly: z.number().min(0).optional(),
  hsa_coverage: z.enum(["self", "family"]).optional(),
  hsa_employer_monthly: z.number().min(0).optional(),
  employer_401k_match_rate_percent: z.number().min(0).max(200).optional(),
  employer_401k_match_limit_percent: z.number().min(0).max(100).optional(),
  expected_annual_return_percent: z.number().min(0).max(30).optional(),
  growth_years: z.number().int().min(1).max(60).optional(),
  marginal_tax_rate_percent: z.number().min(0).max(60).optional(),
  loan_balance: z.number().min(0).optional(),
  loan_payment_monthly: z.number().min(0).optional(),
  loan_interest_rate_percent: z.number().min(0).max(100).optional(),
  investment_label: z.string().optional(),
  investment_monthly: z.number().min(0).optional(),
  investment_return_percent: z.number().min(0).max(30).optional(),
  cash_savings_balance: z.number().min(0).optional(),
  current_401k_balance: z.number().min(0).optional(),
  current_hsa_balance: z.number().min(0).optional(),
  current_investment_balance: z.number().min(0).optional(),
  other_assets_balance: z.number().min(0).optional(),
  items: z.array(financeBudgetItemSchema).optional(),
});

export const financeEquityGrantSchema = z.object({
  id: z.string().min(1),
  company: z.string().optional(),
  label: z.string().optional(),
  grant_type: z.enum(["iso", "nso", "rsu", "options", "other"]).optional(),
  shares: z.number().min(0).optional(),
  strike_price: z.number().min(0).optional(),
  current_fmv: z.number().min(0).optional(),
  vested_shares: z.number().min(0).optional(),
  exercised_shares: z.number().min(0).optional(),
  vesting_start: dateString.optional(),
  vesting_months: z.number().int().positive().optional(),
  cliff_months: z.number().int().min(0).optional(),
  notes: z.string().optional(),
});

export const financePlanSchema = z.object({
  offer: financeOfferSchema.optional(),
  budget: financeBudgetSchema.optional(),
  equity: z.array(financeEquityGrantSchema).optional(),
  notes: z.string().optional(),
});
