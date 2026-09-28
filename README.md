<span align="center">

# Homebridge Plugin for Faber Range Hoods

</span>

<span align="center">

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![npm](https://img.shields.io/npm/v/homebridge-faber-range-hood/latest?label=latest)](https://www.npmjs.com/package/homebridge-faber-range-hood)
[![npm](https://img.shields.io/npm/dt/homebridge-faber-range-hood)](https://www.npmjs.com/package/homebridge-faber-range-hood)

</span>

# Overview

This plugin provides Homebridge support for Faber range hoods. This works for hoods that are controllable using the Faber Cloud App.

Each hood appears in the Home app with:
- Its fan, with its speed
- Its light, with its brightness and, if the hood supports it, its color temperature
- Its carbon and grease filters, showing how much life they have left, and letting you reset them after replacing them

Only what the hood supports is shown (e.g. a ducted hood has no carbon filter). Changes made on the hood itself, or in the Faber Cloud App, show up in the Home app within about a second.

## Requirements

- Homebridge 2
- Node.js 22.10 or later, 24, or 26
- A Faber Cloud account, with the hood set up in the Faber Cloud App

# Configuration

In order to configure this plugin in Homebridge, you'll need two pieces of information:
1. A "refresh token". This is an OAuth/OpenID refresh token that allows the plugin to maintain the proper credentials for access to the Faber Cloud API
2. One or more "device ID" values. Each range hood that's associated with your Faber Cloud API has a unique device ID. You'll use this device ID to instruct the plugin which range hood(s) to control

In order to obtain both of those pieces of information, you'll need to run the `get_token.py` Python script. This script will walk you through logging into the Faber Cloud API, provide you with a refresh token, and show you all the device IDs that are associated with your account

The easiest way to configure the plugin is through the Homebridge UI's plugin settings. The resulting config looks like this:
```json
{
    "platform": "FaberRangeHood",
    "name": "Faber Range Hood",
    "auth_mode": "token",
    "refresh_token": "eyJraWQiO...",
    "devices": [
        { "id": "PINb12jghtk23D9WEoweif", "name": "Kitchen Hood" }
    ]
}
```

| Option | Description |
|---|---|
| `refresh_token` | Required. See below |
| `devices` | The hoods to show in the Home app, by their device ID (see below). A hood's `name` is optional. Changing it renames the hood, and its light, fan, and filters, in the Home app, replacing any names set there |
| `fallback_poll_interval` | Optional. The hoods' status is pushed to Homebridge as it changes. As a safety net, it's also polled this often, in seconds (300 by default, and at least 30) |

The config is checked when Homebridge starts. If anything's wrong with it, the plugin logs what, and doesn't start until it's fixed.

The plugin keeps its login to the Faber cloud up to date by itself, so you only need to provide a refresh token once. If the Homebridge log says that the refresh token has expired or is invalid (e.g. after changing your Faber account's password), get a new one with `get_token.py`, update the config, and restart Homebridge.

## Running get_token.py

`get_token.py` needs Python 3.9 or later, and a computer with a web browser (it doesn't need to be the one Homebridge runs on). It doesn't need any other packages, or admin rights.

1. Download [`tools/get_token.py`](tools/get_token.py) from this repository (or clone it)
2. In your favorite terminal, run it: `python3 get_token.py`
3. This should open up your web browser to the Franke/Faber login page
4. Login using your regular credentials
5. Your web browser might ask you to allow redirecting to `FaberRedirectHandler.app` (or allow opening a link in an external handler). This is a custom handler that's dynamically created by the script itself, and removed once it's done. Click "Allow"
6. Switch back to your terminal. The script lists the range hoods in your Faber account, and prints the plugin config for them, with your refresh token
7. In the Homebridge UI, open the plugin's JSON config (from the plugin's menu), replace its contents with the printed config, and save. To name a hood in the Home app, add a `"name"` next to its `"id"`

If you don't log in within 5 minutes, the script gives up; just run it again.

### Troubleshooting get_token.py

- If you get an error that looks like `urlopen error [SSL: CERTIFICATE_VERIFY_FAILED]`, Python can't find your system's certificates. On macOS, with Python from python.org, run the `Install Certificates.command` in your Python's folder under Applications. Otherwise, try installing the `pip-system-certs` Python package (e.g. `pip3 install pip-system-certs`)

# Troubleshooting

The plugin's messages appear in the Homebridge log. For more detail (e.g. every status update the hoods report, and which ones the plugin applies), turn on Homebridge's debug mode (`-D`), in the Homebridge UI's settings.

# Upgrading

Hoods stay paired, with their rooms and automations, across upgrades. See the [changelog](CHANGELOG.md) for everything that changed.

## From 2.x

Version 3 requires Homebridge 2, and Node.js 22.10 or later, 24, or 26. Upgrade those first.

## From 1.x

In addition to the above, the plugin now checks its config when Homebridge starts (see [Configuration](#configuration)). The first time it starts, it removes the controls for features a hood doesn't have.

# Development

1. Install the dependencies with `npm ci`
2. Copy `test/config.example.json` to `test/hbConfig/config.json`, then fill in your refresh token and device ID (see [Running get_token.py](#running-get_tokenpy)). The `test/hbConfig` directory is gitignored, so your refresh token stays out of the repository
3. Run `npm run watch` to build the plugin and run it in a local Homebridge instance, restarting it whenever the source changes
