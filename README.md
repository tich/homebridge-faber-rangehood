<span align="center">

# Homebridge Plugin for Faber Range Hoods

</span>

> [!IMPORTANT]
> There is no support for retrieving a refresh token on Windows or Linux yet. The `get_token.py` script only supports macOS for now. Contributions are very welcome!

# Overview

This plugin provides Homebridge support for Faber range hoods. This works for hoods that are controllable using the Faber Cloud App.

# Configuration

In order to configure this plugin in Homebridge, you'll need two pieces of information:
1. A "refresh token". This is an OAuth/OpenID refresh token that allows the plugin to maintain the proper credentials for access to the Faber Cloud API
2. One or mode "device ID" values. Each range hood that's associated with your Faber Cloud API has a unique device ID. You'll use this device ID to instruct the plugin which range hood(s) to control

In order to obtain both of those pieces of information, you'll need to run the `get_token.py` Python script. This script will walk you through logging into the Faber Cloud API, provide you with a refresh token, and show you all the device IDs that are associated with your account

## Running get_token.py

1. Clone this repository (or download it from github)
2. Install the `oidc-client` [Python module](https://pypi.org/project/oidc-client/) (e.g. `pip3 install oidc-client`)
3. In your favorite terminal, run the script under `tools/get_token.py`
4. This should open up your web browser to the Franke/Faber login page
5. Login using your regular credentials
6. Your web browser might ask you to allow redirecting to `FaberRedirectHandler.app`. This is a custom app that's dynamically created by the script itself. Click "Allow"
7. Once you see a new webpage that says you're logged in, you can close both of these tabs in your browser
8. Switch back to your terminal
9. The script should've printed out a refresh token, and a list of the devices associated with your account

# TODO

- Ensure transient network errors are properly handled and recovered from (perhaps exponential backoffs using the axios-retry module)
- Properly distinguish between a network error and a token expiration in OpenIDSession
- Enforce no-throw somehow, or convert all exceptions to errors (using the neverthrow module)
- Implement scheme handlers for Linux and Windows in get_token.py
- Implement filter maintenance reminders
