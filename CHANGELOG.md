# Changelog

## 3.0.0

### Breaking changes

- Requires Homebridge 2, and Node.js 22.10 or later, 24, or 26, like Homebridge 2 itself. Homebridge 1 and Node.js 20 are no longer supported

### Other changes

- Documented how the plugin receives updates in real time (see [docs/astarte_api.md](docs/astarte_api.md#real-time-updates-astarte-channels))

## 2.0.0

### Breaking changes

- The plugin config is now checked when Homebridge starts. If it's invalid (e.g. the refresh token is missing, or a device has no ID), the plugin logs what's wrong and doesn't start, rather than failing later
- Only the features a hood reports having are exposed to HomeKit. For example, a ducted hood no longer shows a carbon filter, and a light without adjustable color temperature no longer shows a color temperature control

### New

- The hoods' status is pushed to HomeKit as it changes (e.g. when using the hood's own buttons), within about a second. It's also polled every 5 minutes as a safety net, which the new `fallback_poll_interval` option adjusts. When push updates aren't available, the status is polled every few seconds, as before
- Renaming a device in the plugin config renames it, and its light, fan, and filters, in the Home app. Names changed in the Home app are otherwise kept
- The light, fan, and filters show their own names in the Home app on iOS 16 and later
- The color temperature control covers the hoods' actual 2700K to 6500K range, and snaps to their color temperature settings
- A filter shows as new as soon as it's reset
- Detailed debug logging of the hoods' status updates

### Fixes

- A command that fails (e.g. during a network outage) is reported as failed in the Home app, rather than appearing to succeed. A command that takes too long fails before HomeKit gives up on it, rather than completing later
- Setting the light's brightness and turning it on at the same time (e.g. "set the light to 50%") no longer sends conflicting commands to the hood, and dragging a slider no longer makes it jump back
- A low brightness or fan speed no longer turns the light or fan off
- The color temperature shown in the Home app reflects the hood's, rather than its brightness
- The status keeps being updated after a network error, rather than stopping until Homebridge restarts
- The plugin recovers by itself when Homebridge starts before the network is up (e.g. after a power outage), rather than needing a restart
- A network error at startup no longer removes the hood from HomeKit
- Various fixes to how the plugin logs in to the Faber cloud, which could fail until Homebridge restarted after a network error
- The refresh token can no longer end up in the Homebridge log
- Errors in the plugin can no longer make Homebridge shut down
- Updated dependencies with known security vulnerabilities
