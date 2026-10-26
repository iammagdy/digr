import { beforeEach } from "vitest";
import { setMailDomainResolverForTesting } from "../../src/lib/server/mailDomainCheck";

// No test touches the network for the mail-server check of a work email's domain: every domain has a mail server unless a test says otherwise.
beforeEach(() => { setMailDomainResolverForTesting(async () => "mx"); });
