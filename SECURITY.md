# Security Policy

## Supported Versions

We release patches for security vulnerabilities. The following versions are currently supported:

| Version | Supported          |
| ------- | ------------------ |
| 2.x.x   | :white_check_mark: |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

*Note: We highly recommend always using the latest stable release to ensure you have the latest security patches.*

## Reporting a Vulnerability

We deeply appreciate the efforts of the security community in helping us maintain the security and privacy of our project. 

### Where to report
Please report security vulnerabilities **privately**. Do **not** open a public GitHub issue for a security vulnerability. 

To report a vulnerability, please use the **[Private Vulnerability Reporting](../../security/advisories/new)** tool directly on this repository. This ensures your report is encrypted and only visible to the maintainers.

If you have questions about the process before submitting a report, you can reach out to the maintainer [@atrumin16](https://github.com/atrumin16) via GitHub Discussions (if enabled).

### What to include
To help us triage your report quickly, please include as much of the following information as possible:
- **Type of issue** (e.g., buffer overflow, SQL injection, cross-site scripting, broken access control).
- **Affected components:** Full paths of source file(s) or modules related to the issue.
- **Location:** The specific tag, branch, or commit where the issue occurs.
- **Reproduction:** Step-by-step instructions to reproduce the issue.
- **Proof-of-Concept (PoC):** Exploit code or screenshots (if possible).
- **Impact:** How an attacker might exploit the issue and what the potential damage could be.

### What to expect (Response SLA)
- **Acknowledgment:** We will acknowledge receipt of your report within **48 hours**.
- **Triage:** We will provide a detailed response and validate the issue within **5 business days**, outlining our intended fix timeline.
- **Resolution:** We aim to release patches for critical and high-severity vulnerabilities within **30 days** of confirmation.

### Disclosure Policy
We follow a **90-day Coordinated Vulnerability Disclosure (CVD)** policy. Please do not disclose the vulnerability to the public or third parties until we have released a fix or 90 days have passed. Once a patch is released, we will gladly credit you in the release notes and security advisories (unless you prefer to remain anonymous).

### Safe Harbor
We consider security research conducted in accordance with this policy to be "authorized" conduct. We will not pursue legal action against researchers who discover and report vulnerabilities in good faith, provided that:
- You make a good faith effort to avoid privacy violations, destruction of data, and interruption or degradation of our service.
- You only interact with accounts you own or with the explicit permission of the account holder.
- You do not use automated scanners that generate significant traffic or attempt DDoS attacks.
- You do not exfiltrate or modify user data.
