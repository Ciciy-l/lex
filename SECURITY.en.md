<p align="right">
  <a href="SECURITY.md">简体中文</a> · <strong>English</strong>
</p>

# Security Policy

Do not disclose unpatched security vulnerabilities, credentials, tokens, or
directly exploitable details in public issues, pull requests, discussions, or
chat.

## Reporting a vulnerability

The preferred channel is GitHub's private vulnerability reporting form:

<https://github.com/Ciciy-l/lex/security/advisories/new>

If that form is unavailable, do not post exploit details in a public issue.
First make non-sensitive contact through the repository maintainer's GitHub
profile and agree on a private transfer method. Issues affecting only Cindy
accounts or official online services should be reported directly under Cindy's
official security policy.

## What to include

Please provide as much of the following as possible:

- affected version, commit, or distribution channel;
- affected platform, component, and configuration;
- reproduction steps, a minimal PoC, or logs, after removing credentials and
  personal data;
- potential impact, exploitation requirements, and any suggested mitigation.

If the issue also involves the independently maintained server, identify the
affected regional endpoint and client version so that we can route it to the
appropriate maintainers. The server is outside this repository, but its
details must not be disclosed in a public issue either.

## Response process

Community maintainers will acknowledge, reproduce, and assess reports as soon
as practical and coordinate disclosure timing with the reporter. No commercial
support SLA is currently offered.

## Contributor notes

- Do not put real user data, access tokens, private keys, or internal endpoints
  in issues, test fixtures, or commits.
- If you accidentally commit sensitive information, report it privately
  immediately. Deleting the file from the working tree does not invalidate
  secrets that may exist in Git history.
- Use public issues for ordinary bugs, documentation problems, and feature
  requests. Do not use the security channel for those topics.
