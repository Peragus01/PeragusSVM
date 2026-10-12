import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
export function CopyButton({
  value,
  label = "Copy",
  className = "",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      className={`h-7 w-7 shrink-0 ${className}`}
      title={error ? "Copy unavailable. Select and copy the value." : copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setError(false);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          setError(true);
        }
      }}
    >
      {copied ? <Check className="text-primary" /> : <Copy />}
    </Button>
  );
}
