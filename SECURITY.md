# Security Policy

## Supported Versions

Pi^n is an early-preview project. Security fixes target the latest `main` revision.

## Reporting Vulnerabilities

Please report security issues privately through [GitHub Security Advisories](https://github.com/zhexusun10/pi-n/security/advisories/new). Include the affected revision, impact, and reproduction steps. Avoid sharing credentials or private data.

## Security Considerations

Pi^n can execute commands and modify project files, including during planning. Use trusted projects and extensions, and keep the local API private. Git isolation is not a security sandbox, and rejecting a graph does not undo earlier changes.

Before running important work, read the [user safety guide](docs/user-guide.md#before-you-approve). Developer details live in [Filesystem isolation](docs/architecture/filesystem-isolation.md) and the [execution lifecycle](docs/architecture/execution-model.md).