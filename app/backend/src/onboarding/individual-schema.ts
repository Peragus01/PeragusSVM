import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const cpf = z.string().trim().regex(/^(?:\d{11}|\d{3}\.\d{3}\.\d{3}-\d{2})$/)
  .transform(value => value.replace(/[.-]/g, "")).refine(value => {
    if (/^(\d)\1{10}$/.test(value)) return false;
    const digits = [...value].map(Number);
    return [9, 10].every(count => {
      const sum = digits.slice(0, count).reduce((total, n, i) => total + n * (count + 1 - i), 0);
      return digits[count] === ((sum * 10) % 11) % 10;
    });
  }, "Invalid CPF");
const states = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"] as const;

export function individualDraftSchema(now: Date = new Date()) {
  const birthDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (type: string) => parts.find(item => item.type === type)!.value;
    const today = `${part("year")}-${part("month")}-${part("day")}`;
    let age = Number(part("year")) - date.getUTCFullYear();
    if (today.slice(5) < value.slice(5)) age--;
    return age >= 18 && age <= 120;
  }, "Birth date must be a real date, age 18 to 120");
  return z.object({
    legal_name: text(160).refine(value => value.length >= 2),
    cpf, date_of_birth: birthDate,
    nationality: z.string().regex(/^[A-Z]{2}$/),
    phone: z.object({
      country_code: z.string().regex(/^\+?[1-9]\d{0,3}$/).transform(value => `+${value.replace(/^\+/, "")}`),
      number: z.string().regex(/^\d{5,20}$/),
    }).strict().refine(value => value.country_code.length - 1 + value.number.length <= 20),
    residential_address: z.object({
      line1: text(160), number: text(20), neighborhood: text(100), city: text(100),
      state: z.enum(states), postal_code: z.string().regex(/^\d{5}-?\d{3}$/).transform(value => value.replace("-", "")),
      country: z.literal("BR"), complement: text(160).optional(),
    }).strict(),
    source_of_funds: text(160),
    // Local MVP form bounds, not provider limits or permission to transact.
    monthly_income_usd: z.number().finite().min(0).max(1_000_000_000),
    expected_monthly_volume_usd: z.number().finite().min(0).max(1_000_000_000),
    occupation: text(160).optional(), account_purpose: text(160).optional(),
    is_pep: z.boolean().optional(),
  }).strict();
}
export type IndividualDraft = z.infer<ReturnType<typeof individualDraftSchema>>;
export function individualDraftRequestSchema(now?: Date) {
  return z.object({ expected_version: z.number().int().min(0).max(2_000_000_000),
    individual: individualDraftSchema(now),
  }).strict();
}
