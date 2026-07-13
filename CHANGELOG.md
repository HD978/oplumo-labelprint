# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-13

Initial release.

### Added

- Visual millimetre-precise label template designer with text, line, box,
  barcode, QR code, and image elements.
- Print-time parameters (`{{name}}` placeholders) with defaults, fillable from
  the web UI or REST API.
- Server-rendered PNG previews that match the print pipeline.
- Print targets: PDF download, browser print, TSPL download, Web Bluetooth
  TSPL, WebUSB TSPL, USB device path, CUPS raw queue, and network socket.
- Print history with quick reprint, including browser-managed print actions.
- REST API for templates, targets, previews, raw job bytes, and printing.
- Docker development environment and single-image production deployment.

[0.1.0]: https://github.com/xingrz/labelprint/releases/tag/v0.1.0
