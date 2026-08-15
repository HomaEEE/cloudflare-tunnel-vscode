# Change Log

All notable changes to the Cloudflare Tunnels for VSCode extension will be documented in this file.

## [1.1.0]

### Added

- Automatic detection of Laravel Herd and Valet sites from the current VS Code workspace.
- Automatic public hostname generation from the local site hostname, for example `crm.test` -> `crm.example.com`.
- Persistent history of the last 10 local origins.
- Herd/Valet-compatible named tunnel configuration using `httpHostHeader`.
- Automatic DNS routing for named Cloudflare tunnels.
- Quick Tunnel fallback when Cloudflare is not authenticated or no base domain is configured.
- Cleanup of temporary tunnel configuration files on stop/deactivation.

### Changed

- Named tunnels now use the public hostname as their identity instead of the local port, so multiple sites sharing port 80/443 can run simultaneously.
- The existing `tunnel.defaultHostname` setting now represents the base public domain.

## [1.0.3] - 2024-09-24

- MacOS support: prevent killing cloudflared on non-fatal errors.
- Removed original compressed cloudflared client file for MacOS.

## [1.0.2] - 2024-08-26

### Changed

- Improved login to cloudflare.

## [1.0.1] - 2024-08-24

### Changed

- Fixed missing tar npm dependency

## [1.0.0] - 2024-08-24

### Changed

- Create multiple tunnels.
- New tree view based interface.
- Added support for Mac OS.
- Improved error handling.
- Increased log visibility.

## [0.3.4] - 2022-08-03

### Changed

- Migrated legacy tunnels to named tunnels.

## [0.3.3] - 2022-01-06

### Changed

- Show progress while downloading cloudflared client on startup.

## [0.3.1] - 2022-01-05

### Changed

- Preview gif.
- vscode package settings.
- Changed activation event to `onStartupFinished` for performance reasons.

## [0.3.0] - 2022-01-04

### Added

- Graphical interface to start and stop the tunnel.
- Config settings to enable or thisable the GUI.

## [0.2.3] - 2021-11-23

### Added

- Allow using hostnames other than `localhost`.

### Changed

- Fix cloudflared client downloading multiple times.

## [0.2.2] - 2021-11-22

### Changed

- Set cloudflared client permissions after downloading in linux.

## [0.2.1] - 2021-11-22

### Changed

- Refactor command related code.

## [0.2.0] - 2021-11-22

### Added

- Login to cloudflare.
- Add custom domain through settings.

### Changed

- Improved error handling.
- Stop running tunnel if already started.

## [0.1.0] - 2021-11-21

### Added

- Initial release.
- Start tunnel command.
- Stop tunnel command.
- Is running command.
- Port input.
- Automatically download clourdflared client.
