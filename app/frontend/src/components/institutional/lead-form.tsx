import { useRef, useState, type FormEvent } from "react";
import { ArrowRight } from "lucide-react";
import { BookingLink } from "./booking";

const fields = [
  { name: "fullName", label: "Full Name", autoComplete: "name", min: 2, max: 120, type: "text" },
  {
    name: "corporateEmail",
    label: "Corporate Email",
    autoComplete: "email",
    min: 3,
    max: 254,
    type: "email",
  },
  {
    name: "company",
    label: "Company",
    autoComplete: "organization",
    min: 2,
    max: 160,
    type: "text",
  },
  {
    name: "position",
    label: "Position",
    autoComplete: "organization-title",
    min: 2,
    max: 120,
    type: "text",
  },
  {
    name: "country",
    label: "Country",
    autoComplete: "country-name",
    min: 2,
    max: 100,
    type: "text",
  },
  { name: "website", label: "Company Website", autoComplete: "url", min: 0, max: 300, type: "url" },
] as const;

const interests = [
  "Cross-Border Payments",
  "Payment Infrastructure",
  "Liquidity Provider Partnership",
  "Fintech Integration",
  "Strategic Partnership",
  "Other",
];

const invalidMessages = {
  corporateEmail: "Enter a valid work email address.",
  website: "Enter a full website address starting with https:// or http://.",
  interest: "Select an area of interest.",
};

function fieldMessage(name: string) {
  return Object.hasOwn(invalidMessages, name)
    ? invalidMessages[name as keyof typeof invalidMessages]
    : undefined;
}

export function LeadForm() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [received, setReceived] = useState(false);
  const inFlight = useRef(false);

  function clearError(name: string) {
    setErrors((current) => ({ ...current, [name]: "" }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || received) return;
    const form = event.currentTarget;
    const body = Object.fromEntries(
      Array.from(new FormData(form), ([name, value]) => [name, String(value).trim()]),
    );
    const nextErrors: Record<string, string> = {};
    for (const field of fields) {
      const input = form.elements.namedItem(field.name) as HTMLInputElement;
      const value = body[field.name] ?? "";
      if (value.length < field.min || value.length > field.max || input.validity.typeMismatch) {
        nextErrors[field.name] =
          fieldMessage(field.name) ?? `Enter your ${field.label.toLowerCase()}.`;
      }
    }
    if (body["website"] && !/^https?:\/\//i.test(body["website"]))
      nextErrors["website"] = invalidMessages.website;
    if (!interests.includes(body["interest"] ?? ""))
      nextErrors["interest"] = invalidMessages.interest;
    setErrors(nextErrors);
    setMessage("");
    const firstInvalid = Object.keys(nextErrors)[0];
    if (firstInvalid) {
      (form.elements.namedItem(firstInvalid) as HTMLElement | null)?.focus();
      return;
    }

    inFlight.current = true;
    setSending(true);
    try {
      const response = await fetch("/api/public/commercial-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json();
      if (response.ok && data.received === true) {
        setReceived(true);
        return;
      }
      if (response.status === 429) {
        setMessage("Too many requests. Wait a minute and try again.");
        return;
      }
      const invalid: string[] = Array.isArray(data.error?.fields) ? data.error.fields : [];
      const serverErrors: Record<string, string> = {};
      for (const name of invalid) {
        const field = fields.find((item) => item.name === name);
        if (field || name === "interest") {
          serverErrors[name] = fieldMessage(name) ?? `Check your ${field?.label.toLowerCase()}.`;
        }
      }
      setErrors(serverErrors);
      const first = Object.keys(serverErrors)[0];
      if (first) (form.elements.namedItem(first) as HTMLElement | null)?.focus();
      else setMessage("We couldn’t submit your inquiry. Please try again or contact us by email.");
    } catch {
      setMessage("We couldn’t reach the inquiry service. Please try again or contact us by email.");
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <div className="ih-form-panel">
      <h3>Tell us about your business</h3>
      <div role="status">{received && <p>Thank you. We have received your inquiry.</p>}</div>
      {received ? (
        <BookingLink />
      ) : (
        <form onSubmit={submit} noValidate aria-busy={sending}>
          <div className="ih-fields">
            {fields.map(({ name, label, autoComplete, min, max, type }) => (
              <div key={name}>
                <label htmlFor={`lead-${name}`}>
                  {label}
                  {!min && <small> (optional)</small>}
                </label>
                <input
                  id={`lead-${name}`}
                  name={name}
                  autoComplete={autoComplete}
                  type={type}
                  required={Boolean(min)}
                  minLength={min}
                  maxLength={max}
                  aria-invalid={Boolean(errors[name])}
                  aria-describedby={errors[name] ? `lead-${name}-error` : undefined}
                  onChange={() => clearError(name)}
                />
                {errors[name] && (
                  <p className="ih-error" id={`lead-${name}-error`}>
                    {errors[name]}
                  </p>
                )}
              </div>
            ))}
            <div className="ih-interest">
              <label htmlFor="lead-interest">Area of Interest</label>
              <select
                id="lead-interest"
                name="interest"
                required
                defaultValue=""
                aria-invalid={Boolean(errors["interest"])}
                aria-describedby={errors["interest"] ? "lead-interest-error" : undefined}
                onChange={() => clearError("interest")}
              >
                <option value="" disabled>
                  Select an option
                </option>
                {interests.map((interest) => (
                  <option key={interest}>{interest}</option>
                ))}
              </select>
              {errors["interest"] && (
                <p className="ih-error" id="lead-interest-error">
                  {errors["interest"]}
                </p>
              )}
            </div>
          </div>
          <div hidden>
            <input name="fax" tabIndex={-1} autoComplete="off" defaultValue="" />
          </div>
          <p className="ih-privacy">
            Peragus uses these details to review and respond to your business inquiry. See our{" "}
            <a href="/legal/politica-de-privacidade.html">Privacy Policy</a>.
          </p>
          {message && (
            <p role="alert" className="ih-error">
              {message}
            </p>
          )}
          <button className="ih-button" type="submit" disabled={sending}>
            {sending ? "Sending inquiry…" : "Send inquiry"}{" "}
            <ArrowRight size={17} aria-hidden="true" />
          </button>
        </form>
      )}
    </div>
  );
}
