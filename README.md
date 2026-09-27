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

# Configuration

In order to configure this plugin in Homebridge, you'll need two pieces of information:
1. A "refresh token". This is an OAuth/OpenID refresh token that allows the plugin to maintain the proper credentials for access to the Faber Cloud API
2. One or more "device ID" values. Each range hood that's associated with your Faber Cloud API has a unique device ID. You'll use this device ID to instruct the plugin which range hood(s) to control

In order to obtain both of those pieces of information, you'll need to run the `get_token.py` Python script. This script will walk you through logging into the Faber Cloud API, provide you with a refresh token, and show you all the device IDs that are associated with your account

## Running get_token.py

1. Clone this repository (or download it from github)
2. Install the `oidc-client` [Python module](https://pypi.org/project/oidc-client/) (e.g. `pip3 install oidc-client`)
3. In your favorite terminal, run the script under `tools/get_token.py`
4. This should open up your web browser to the Franke/Faber login page
5. Login using your regular credentials
6. Your web browser might ask you to allow redirecting to `FaberRedirectHandler.app` (or allow opening a link in an external handler). This is a custom handler that's dynamically created by the script itself. Click "Allow"
7. Switch back to your terminal
8. The script should've printed out a refresh token, and a list of the devices associated with your account

### Troubleshooting get_token.py

- If you get an error that looks like `urlopen error [SSL: CERTIFICATE_VERIFY_FAILED]`, then try installing the `pip-system-certs` Python package (e.g. `pip3 install pip-system-certs`)

# Development

1. Install the dependencies with `npm ci`
2. Copy `test/config.example.json` to `test/hbConfig/config.json`, then fill in your refresh token and device ID (see [Running get_token.py](#running-get_tokenpy)). The `test/hbConfig` directory is gitignored, so your refresh token stays out of the repository
3. Run `npm run watch` to build the plugin and run it in a local Homebridge instance, restarting it whenever the source changes
