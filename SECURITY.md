# Security policy

Ruby handles team accounts, internal documents and encrypted employee data, so we take reports seriously.

## Reporting a vulnerability

Report privately with GitHub Security Advisories on [studiomicro/ruby](https://github.com/studiomicro/ruby): open the
**Security** tab and choose **Report a vulnerability**
(<https://github.com/studiomicro/ruby/security/advisories/new>). Do not open a public issue or pull request for a
vulnerability.

Please include what you found, steps to reproduce, and the impact. We aim to acknowledge a report within a few days
and will tell you when it is fixed.

## In scope

- Authentication, invites, sessions, password handling and the Cloudflare Access check.
- Reading or changing data without the right role (admin, HR, member) or across ids a user may not see.
- Injection, XSS (including the Markdown renderer), CSRF and SSRF.
- The attachment upload and download routes.
- Leaks of secrets, session tokens or personal data, and weaknesses in the HR data encryption.

## Out of scope

- Findings that need a compromised browser, a rooted device or physical access.
- Denial of service by volume, and automated scanner output without a working proof.
- Missing best-practice headers with no demonstrated impact.
- Vulnerabilities in third-party services (Cloudflare, GitHub); report those to the vendor.

## Rules for testing

Test only against your own self-hosted instance or your own accounts. Never access, change or delete another
person's data, and stop once you have shown the issue. Do not test an instance operated by someone else without their
written permission.
