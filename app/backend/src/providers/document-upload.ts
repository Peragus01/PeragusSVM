import https from "node:https";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { DocumentError } from "../onboarding/customer-documents.js";

export function publicIPv4(ip: string) {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a! >= 224 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && [0, 2, 168].includes(b!)) ||
    (a === 198 && [18, 19, 51].includes(b!)) ||
    (a === 203 && b === 0)
  );
}
export async function uploadDocumentBytes(
  url: URL,
  bytes: Buffer,
  mime: string,
): Promise<void> {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    isIP(url.hostname)
  )
    throw new DocumentError("DOCUMENT_UPLOAD_ORIGIN_REFUSED");
  let addresses: string[];
  try {
    addresses = await new Resolver({ timeout: 2000, tries: 1 }).resolve4(
      url.hostname,
    );
  } catch {
    throw new DocumentError("DOCUMENT_UPLOAD_UNCONFIRMED");
  }
  if (!addresses.length || addresses.some((ip) => !publicIPv4(ip)))
    throw new DocumentError("DOCUMENT_UPLOAD_ORIGIN_REFUSED");
  // Pin the checked address while keeping the original hostname for TLS verification.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failed) reject(new DocumentError("DOCUMENT_UPLOAD_UNCONFIRMED"));
      else resolve();
    };
    const req = https.request(
      url,
      {
        method: "PUT",
        family: 4,
        agent: false,
        lookup: (_hostname, options, callback) => {
          if (options.all)
            callback(null, [{ address: addresses[0]!, family: 4 }]);
          else callback(null, addresses[0]!, 4);
        },
        headers: { "Content-Type": mime, "Content-Length": bytes.length },
      },
      (res) => {
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > 8192) {
            finish(true);
            req.destroy();
          }
        });
        res.on("error", () => {
          finish(true);
          req.destroy();
        });
        res.on("aborted", () => {
          finish(true);
          req.destroy();
        });
        res.on("close", () => {
          if (!res.complete) finish(true);
        });
        res.on("end", () =>
          finish(
            !(res.statusCode && res.statusCode >= 200 && res.statusCode < 300),
          ),
        );
      },
    );
    const timer = setTimeout(() => {
      finish(true);
      req.destroy();
    }, 10000);
    req.on("error", () => finish(true));
    req.end(bytes);
  });
}
