/**
 * Does the domain of an email address have a mail server? A free DNS check made on our own server before a found work email is delivered and
 * charged: an address on a domain with no mail server can never receive a message. Only the DOMAIN is looked up, never the address.
 *
 * «mx»: the domain publishes mail servers. «a»: no MX record, but the domain has an address record (the implicit-MX fallback of the mail
 * standard; the deliverability check decides the rest). «none»: the domain does not exist or has neither (or publishes a null MX).
 * «unknown»: the lookup itself failed (timeout, resolver error); an unanswered question never keeps an address out.
 */
export type MailDomainStatus = "mx" | "a" | "none" | "unknown";
export type MailDomainResolver = (domain: string) => Promise<MailDomainStatus>;

/** A DNS answer comes in milliseconds; a resolver that does not answer in this time is «unknown». */
export const MAIL_DOMAIN_CHECK_TIMEOUT_MS = 2_500;

const NO_RECORD_CODES = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("dns_timeout"), { code: "ETIMEOUT" })), ms);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });

export const defaultMailDomainResolver: MailDomainResolver = async (domain) => {
  const dns = await import("node:dns").then((module) => module.promises);
  const missing = (error: any): boolean => NO_RECORD_CODES.has(String(error?.code || ""));
  try {
    const records = await withTimeout(dns.resolveMx(domain), MAIL_DOMAIN_CHECK_TIMEOUT_MS);
    // «0 .» is a null MX: the domain says it takes no mail
    const real = records.filter((record) => String(record.exchange || "").replace(/\.$/, "") !== "");
    if (real.length > 0) return "mx";
    if (records.length > 0) return "none";
  } catch (error) {
    if (!missing(error)) return "unknown";
  }
  for (const lookup of [(name: string) => dns.resolve4(name), (name: string) => dns.resolve6(name)]) {
    try {
      const addresses = await withTimeout(lookup(domain), MAIL_DOMAIN_CHECK_TIMEOUT_MS);
      if (addresses.length > 0) return "a";
    } catch (error) {
      if (!missing(error)) return "unknown";
    }
  }
  return "none";
};

/** A resolver that remembers its answers for the life of one request (one domain is asked once however many addresses it carries). */
export function createCachedMailDomainResolver(resolver: MailDomainResolver = defaultMailDomainResolver): MailDomainResolver {
  const cache = new Map<string, Promise<MailDomainStatus>>();
  return (domain) => {
    const key = domain.trim().toLowerCase();
    let answer = cache.get(key);
    if (!answer) {
      answer = resolver(key).catch(() => "unknown" as MailDomainStatus);
      cache.set(key, answer);
    }
    return answer;
  };
}

let resolverOverride: MailDomainResolver | null = null;
/** Tests replace the DNS check (so no test touches the network); null restores the real one. */
export function setMailDomainResolverForTesting(resolver: MailDomainResolver | null): void {
  resolverOverride = resolver;
}
/** The resolver in force: the test's, or the real DNS one. */
export const currentMailDomainResolver = (): MailDomainResolver => resolverOverride ?? defaultMailDomainResolver;
