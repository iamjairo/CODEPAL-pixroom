# Maintainers

Pinpoint is currently maintained by [CodePal](https://codepal.ai) through the
[`CodePalAI`](https://github.com/CodePalAI) GitHub account.

## Decision process

- Routine fixes and documentation changes are decided through pull-request review.
- Security-sensitive changes to MCP confinement, destination isolation, policy parsing,
  receipt authority, or release automation require the focused tests for that surface
  plus the full release validation described in [CONTRIBUTING.md](./CONTRIBUTING.md).
- Evidence claims must link a reproducible receipt, preserve failures and exclusions,
  and state whether the work is first-party or independent.
- Compatibility is preferred over API churn while the project is experimental. Any
  breaking public change must be called out in [CHANGELOG.md](./CHANGELOG.md).

## Roles

CodePal currently owns:

- release signing and npm publication;
- private vulnerability response;
- policy and receipt security review;
- final decisions when consensus is not reached.

The project does not yet claim a multi-maintainer governance model. When additional
trusted maintainers take recurring review or release responsibility, this file will
name them and the repository will require independent release review.

## Contact

- Public architecture and contribution questions: [GitHub Discussions](https://github.com/CodePalAI/pinpoint/discussions)
- Security reports: GitHub private vulnerability reporting, as documented in [SECURITY.md](./SECURITY.md)
- Conduct reports: `support@codepal.ai`, as documented in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
