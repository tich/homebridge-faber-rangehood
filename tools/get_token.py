#!/usr/bin/env python3

import oidc_client as oidc
from dataclasses import dataclass, fields, field
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import json
import plistlib
import webbrowser

import platform
import os
import shutil
import subprocess
import time

try:
    import winreg
except ModuleNotFoundError:
    # This is only needed on Windows and will fail to import
    # on any other OS
    pass

@dataclass
class OpenIDToken:
    token_type: str = None
    scope: str = None
    not_before: int = 0
    id_token_expires_in: int = 0
    id_token: str = None
    refresh_token: str = None
    refresh_token_expires_in: int = 0

@dataclass
class OpenIDConfig:
    auth_endpoint: str
    token_endpoint: str
    auth_extra_params: dict[str,str]
    token_extra_params: dict[str,str]
    client_id: str
    auth_scope: str
    redirect_uri_for_request: str
    local_redirect_uri: str

@dataclass
class AstarteToken:
    token: str = None
    expiration: int = 0

@dataclass
class AstarteConfig:
    realm: str
    user_info_endpoint: str
    token_endpoint: str
    api_endpoint: str
    user_id: str = None
    device_ids: list[str] = None

@dataclass
class State:
    openid_config: OpenIDConfig
    astarte_config: AstarteConfig
    openid_token: OpenIDToken = field(default_factory=OpenIDToken)
    astarte_token: AstarteToken = field(default_factory=AstarteToken)

class AuthorizationError(RuntimeError):
    pass

class SchemeHandlerMacOS:
    def __init__(self, scheme_name: str, openid_config: OpenIDConfig):
        self._scheme_name = scheme_name
        self._openid_config = openid_config
        self._script_path = "/Applications/FaberRedirectHandler.app"

    def __enter__(self):
        print(f"Installing scheme handler at {self._script_path}")
        OSA_SCRIPT_LINES = [
            "use framework \"Foundation\"",
            "use scripting additions",
            "on open location this_URL",
                "set urlComponents to my (NSURLComponents's componentsWithString: this_URL)",
                "tell urlComponents",
                    "set urlQuery to |percentEncodedQuery|() as text",
                    f"set fullUrl to \"{self._openid_config.local_redirect_uri}?\" & urlQuery",
                    "open location fullUrl",
                "end tell",
            "end open location"
        ]

        plist_path = f"{self._script_path}/Contents/Info.plist"
        if os.path.exists(self._script_path):
            shutil.rmtree(self._script_path)
        lines = []
        for line in OSA_SCRIPT_LINES:
            lines.append("-e")
            lines.append(line)
        subprocess.run(["osacompile", *lines, "-o", self._script_path], check=True)
        with open(plist_path, "rb") as plist_file:
            plist = plistlib.load(plist_file)
        plist["CFBundleIdentifier"] = "com.tich.AppleScript.RedirectScheme"
        plist["CFBundleURLTypes"] = [{"CFBundleURLName": "com.tich.AppleScript.RedirectScheme", "CFBundleURLSchemes": [self._scheme_name], "CFBundleTypeRole": "Viewer", "LSIsAppleDefaultForScheme": True}]
        with open(plist_path, "wb") as plist_file:
            plistlib.dump(plist, plist_file)
        subprocess.run(["/System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister", self._script_path], check=True)
        subprocess.run(["open", self._script_path])
        return self

    def __exit__(self, exc_type, exc_value, exc_traceback):
        print(f"Removing scheme handler at {self._script_path}")
        shutil.rmtree(self._script_path)

class SchemeHandlerLinux:
    def __init__(self, scheme_name: str, openid_config: OpenIDConfig):
        self._scheme_name = scheme_name
        self._openid_config = openid_config
        self._script_name = "FaberRedirectHandler.desktop"
        self._script_location = os.path.expanduser("~/.local/share/applications")
        self._script_path = f"{self._script_location}/{self._script_name}"

    def __enter__(self):
        print(f"Installing scheme handler at {self._script_path}")
        local_redirect_uri_escaped = self._openid_config.local_redirect_uri.replace("/", "\\\\/")
        DESKTOP_SCRIPT_LINES = [
            "[Desktop Entry]",
            "Name=FaberRedirectHandler",
            f"Exec=bash -c \"echo %u | sed 's/^.\\\\{{{len(self._openid_config.redirect_uri_for_request)}\\\\}}/{local_redirect_uri_escaped}/' | xargs curl --silent --output /dev/null\"",
            "Type=Application",
            "Terminal=false",
            f"MimeType=x-scheme-handler/{self._scheme_name};"
        ]

        # Remove the desktop file if it already exists
        if os.path.exists(self._script_path):
            os.remove(self._script_path)

        os.makedirs(self._script_location, exist_ok=True)

        with open(self._script_path, 'w') as script:
            script.write("\n".join(DESKTOP_SCRIPT_LINES))

        # Register the desktop file as a scheme handler in XDG
        subprocess.run(["xdg-mime", "default", self._script_name, f"x-scheme-handler/{self._scheme_name}"], check=True)
        # Refresh the database
        subprocess.run(["update-desktop-database", self._script_location], check=True)

        return self

    def __exit__(self, exc_type, exc_value, exc_traceback):
        print(f"Removing scheme handler at {self._script_path}")
        # Remove the desktop file
        os.remove(self._script_path)
        # Remove the entry from mimeapps.list
        mimeapps_file = os.path.expanduser("~/.config/mimeapps.list")
        if not os.path.exists(mimeapps_file):
            print("Warning: Failed to unregister the scheme handler")
            return
        with open(mimeapps_file, 'r+', encoding="utf-8") as mimeapps:
            lines = mimeapps.readlines()
            lines = [line for line in lines if self._script_name not in line]
            mimeapps.seek(0)
            mimeapps.writelines(lines)
            mimeapps.truncate()
        # Refresh the database
        subprocess.run(["update-desktop-database", self._script_location], check=True)

class SchemeHandlerWindows:
    def __init__(self, scheme_name: str, openid_config: OpenIDConfig):
        self._scheme_name = scheme_name
        self._openid_config = openid_config

    def _key_exists(self, parent, key):
        try:
            with winreg.OpenKey(parent, key):
                pass
        except OSError:
            return False
        return True

    def _delete_key_tree(self, parent, key):
        with winreg.OpenKey(parent, key) as key_obj:
            while True:
                try:
                    sub_key = winreg.EnumKey(key_obj, 0)
                except OSError:
                    # No more subkeys
                    break
                self._delete_key_tree(key_obj, sub_key)
        winreg.DeleteKey(parent, key)

    def __enter__(self):
        print(f"Installing scheme handler")

        protocol_command = f"powershell.exe -Command \"Invoke-WebRequest -Uri $('{self._openid_config.local_redirect_uri}/' + '%1'.Substring({len(self._openid_config.redirect_uri_for_request)}))\""

        if self._key_exists(winreg.HKEY_CLASSES_ROOT, self._scheme_name):
            self._delete_key_tree(winreg.HKEY_CLASSES_ROOT, self._scheme_name)

        with winreg.CreateKey(winreg.HKEY_CLASSES_ROOT, self._scheme_name) as root_key:
            winreg.SetValueEx(root_key, "", 0, winreg.REG_SZ, "URL:Faber Redirect Handler")
            winreg.SetValueEx(root_key, "URL Protocol", 0, winreg.REG_SZ, "")
            with winreg.CreateKey(root_key, "shell") as shell_key:
                with winreg.CreateKey(shell_key, "open") as open_key:
                    winreg.SetValue(open_key, "command", winreg.REG_SZ, protocol_command)

        return self

    def __exit__(self, exc_type, exc_value, exc_traceback):
        print(f"Removing scheme handler")
        self._delete_key_tree(winreg.HKEY_CLASSES_ROOT, self._scheme_name)

def _open_authorization_endpoint(openid_config: OpenIDConfig, state: str, pkce_secret: oidc.pkce.PKCESecret, nonce: str):
    """Open a web browser to the authorization URL. This allows the user to sign in securely"""
    params = {
        "client_id": openid_config.client_id,
        "redirect_uri": openid_config.redirect_uri_for_request,
        "response_type": "code",
        "state": state,
        "scope": openid_config.auth_scope,
        "code_challenge": pkce_secret.challenge,
        "code_challenge_method": pkce_secret.challenge_method,
        "prompt": "login",
        "nonce": nonce
    }
    params.update(openid_config.auth_extra_params)
    url = f"{openid_config.auth_endpoint}?{urlencode(params)}"
    webbrowser.open(url)

def _start_authorization_code_flow(state: State, pkce_secret: oidc.pkce.PKCESecret, nonce: str):
    scheme_name = "com.faberspa.mobile.smarthood"
    if platform.system() == "Darwin":
        scheme_handler = SchemeHandlerMacOS(scheme_name, state.openid_config)
    elif platform.system() == "Linux":
        scheme_handler = SchemeHandlerLinux(scheme_name, state.openid_config)
    elif platform.system() == "Windows":
        scheme_handler = SchemeHandlerWindows(scheme_name, state.openid_config)
    else:
        raise RuntimeError(f"Unsupported OS: {platform.system()}")

    with scheme_handler:
        with oidc.oauth.redirection_server(state.openid_config.local_redirect_uri) as httpd:
            _open_authorization_endpoint(
                openid_config=state.openid_config,
                state=httpd.state,
                pkce_secret=pkce_secret,
                nonce=nonce
            )
            while not httpd.code and not httpd.error:
                httpd.handle_request()
            if httpd.error:
                raise httpd.error
            if not httpd.code:
                # This should not ever be reached.
                raise AuthorizationError("no authorization code, unknown error.")

    return httpd.code

def _fetch_openid_token(state: State, code: str, pkce_secret: oidc.pkce.PKCESecret):
    data = {
        "grant_type": "authorization_code",
        "client_id": state.openid_config.client_id,
        "code": code,
        "code_verifier": str(pkce_secret),
    }
    url = f"{state.openid_config.token_endpoint}?{urlencode(state.openid_config.token_extra_params)}"
    request = Request(url, data=urlencode(sorted(data.items())).encode())
    try:
        with urlopen(request) as response:
            token_data = json.load(response)
        for key, value in token_data.items():
            if key in (field.name for field in fields(OpenIDToken)):
                setattr(state.openid_token, key, value)
    except TypeError as error:
        print(json.dumps(token_data, indent=4))
        raise AuthorizationError(str(error))
    except HTTPError as error:
        print(error)
        print(error.read())
        raise AuthorizationError(error.reason)

def _refresh_openid_token(state: State):
    data = {
        "grant_type": "refresh_token",
        "client_id": state.openid_config.client_id,
        "refresh_token": state.openid_token.refresh_token,
    }
    url = f"{state.openid_config.token_endpoint}?{urlencode(state.openid_config.token_extra_params)}"
    request = Request(url, data=urlencode(sorted(data.items())).encode())
    try:
        with urlopen(request) as response:
            token_data = json.load(response)
        for key, value in token_data.items():
            if key in (field.name for field in fields(OpenIDToken)):
                setattr(state.openid_token, key, value)
    except TypeError as error:
        print(json.dumps(token_data, indent=4))
        raise AuthorizationError(str(error))
    except HTTPError as error:
        print(error)
        raise AuthorizationError(error.reason)

def _do_openid_auth(state: State):
    pkce_secret = oidc.pkce.PKCESecret()
    nonce = str(oidc.pkce.PKCESecret(30))
    code = _start_authorization_code_flow(
        state,
        pkce_secret=pkce_secret,
        nonce=nonce
    )
    _fetch_openid_token(
        state,
        code=code,
        pkce_secret=pkce_secret
    )

def _ensure_openid_token(state: State):
    current_time = time.time()
    if current_time < (state.openid_token.not_before + state.openid_token.id_token_expires_in):
        # Nothing to do
        return
    if current_time < (state.openid_token.not_before + state.openid_token.refresh_token_expires_in):
        try:
            _refresh_openid_token(state)
        except AuthorizationError as error:
            # Ignore errors
            pass
    if current_time < (state.openid_token.not_before + state.openid_token.id_token_expires_in):
        # Nothing to do. The refresh worked
        return
    _do_openid_auth(state)

def _fetch_astarte_user_id(state: State):
    _ensure_openid_token(state)
    headers = {"sso-token": state.openid_token.id_token}
    url = f"{state.astarte_config.user_info_endpoint}/{state.astarte_config.realm}"
    request = Request(url, headers=headers, method="GET")
    try:
        with urlopen(request) as response:
            user_info_data = json.load(response)
        return user_info_data["data"]["user_id"]
    except (TypeError, KeyError) as error:
        print(json.dumps(user_info_data, indent=4))
        raise AuthorizationError(str(error))
    except HTTPError as error:
        print(error)
        raise AuthorizationError(error.reason)

def _fetch_astarte_token(state: State):
    if state.astarte_config.user_id is None:
        state.astarte_config.user_id = _fetch_astarte_user_id(state)
    _ensure_openid_token(state)
    headers = {"sso-token": state.openid_token.id_token}
    url = f"{state.astarte_config.token_endpoint}/{state.astarte_config.realm}/users/{state.astarte_config.user_id}/devices"
    request = Request(url, headers=headers, method="GET")
    try:
        with urlopen(request) as response:
            token_data = json.load(response)
        while state.astarte_config.device_ids is None:
            state.astarte_config.device_ids = [device['id'] for device in token_data["data"].get("hoods", {}).get("devices", {})]
        state.astarte_token.token = token_data["data"]["hoods"]["token"]
        state.astarte_token.expiration = state.openid_token.not_before + state.openid_token.id_token_expires_in
    except (TypeError, KeyError) as error:
        print(json.dumps(token_data, indent=4))
        raise AuthorizationError(str(error))
    except HTTPError as error:
        print(error)
        raise AuthorizationError(error.reason)

def _ensure_astarte_token(state: State):
    current_time = time.time()
    if current_time < state.astarte_token.expiration:
        # Nothing to do
        return
    _fetch_astarte_token(state)

def _do_astarte_request(state: State, device_id: str, interface: str, method: str, value: dict[str, any]):
    _ensure_astarte_token(state)
    url = f"{state.astarte_config.api_endpoint}/{state.astarte_config.realm}/devices/{device_id}/interfaces/{interface}"
    headers = {
        "Authorization": f"Bearer {state.astarte_token.token}"
    }
    data = {}
    if value is not None:
        data["data"] = value
        headers["Content-Type"] = "application/json"

    request = Request(url, headers=headers, data=json.dumps(data).encode('utf-8'), method=method)
    try:
        with urlopen(request) as response:
            data = json.load(response)
            return data
    except HTTPError as error:
        print(error)

def _print_device_info(state: State):
    print("Found devices: [")
    for device_id in state.astarte_config.device_ids:
        data = _do_astarte_request(state, device_id, "com.faberspa.DeviceDetails", "GET", None)
        print("    {")
        print(f"        Device ID: {device_id}")
        print(f"        Device Model: {data['data']['modelLine']}")
        print(f"        Device Type: {data['data']['type']}")
        print("    }")
    print("]")
    pass

"""
This is what an authorization request looks like for a web-based sign-in. Figure out if we can use that
instead of the app-based sign-in (probably not, because that redirect_uri is only allowed to get id tokens):

https://login.id.franke.com/frankeid.onmicrosoft.com/b2c_1a_signup_signin/oauth2/v2.0/authorize
    ?client_id=36453a6d-2bcb-4a73-84e5-26af7f7ee87c
    &redirect_uri=https%3A%2F%2Fwww.id.franke.com%2Fsignin-oidc
    &response_type=id_token
    &scope=openid%20profile
    &response_mode=form_post
    &nonce=638981490973977620.MzgzNTRhMmMtZDNjYS00NTQ5LWFkZjctZjJmYmMxMGU0OTI3ZDMwZDY1MmEtZjA2MS00NjQxLTkwYjUtMDY4NWRiYmRkNDc1
    &ui_locales=en
    &state=CfDJ8C0WWv8wiehDl-Kj_AjbrW5aD76Cz6TOlZ8pZpfYNSy1ooZ0aUgt_HH8LKMBB-6jQ4Z9f80etSUfP_Xi1YbpKwsKv9kaTIOY4HZpL4v1kHc97hM08klxMtgEnLENHyZmkA-2jA8--Ajq9Xhhuk12bdsO31ApidGx7gyj6hwSt4jMPPkWeOUX4cQRQTyALb9NY06gJI8qWTeYnoptL1IXCeLDy-8ngrhf_v-mMSi_7IfelyAZyEn2UDqkvIKFxJ7z7eHuynk_29y6c3kSrTGHFbPi_2W1tTemiS6XHWBOIjNvmWOIHeqBIQB0R_WBecTYx71mBytZutOVY62cGfSs82rzZqND69Gw4p2h4HNUriL6
    &x-client-SKU=ID_NET8_0
    &x-client-ver=7.1.2.0
"""
def _main():
    state = State(
            # OpenID config is here: "https://frankeid.b2clogin.com/frankeid.onmicrosoft.com/B2C_1A_signup_signin_localonly_Faber/v2.0/.well-known/openid-configuration"
        openid_config = OpenIDConfig(
            auth_endpoint = "https://frankeid.b2clogin.com/frankeid.onmicrosoft.com/oauth2/v2.0/authorize",
            auth_extra_params = {"p": "B2C_1A_signup_signin_localonly_Faber"},
            token_endpoint = "https://frankeid.b2clogin.com/frankeid.onmicrosoft.com/oauth2/v2.0/token",
            token_extra_params = {"p": "B2C_1A_signup_signin_localonly_Faber"},
            client_id = "12af9176-4d94-4919-950b-c26a8cd655db",
            auth_scope = "openid offline_access",
            redirect_uri_for_request = "com.faberspa.mobile.smarthood://oauth/redirect",
            local_redirect_uri = "http://127.0.0.1:49162"
        ),
        astarte_config = AstarteConfig(
            realm = "faber",
            user_info_endpoint = "https://auth.cloud.faberspa.com/astarte-associator/user_info",
            token_endpoint = "https://auth.cloud.faberspa.com/astarte-associator/tokens",
            api_endpoint = "https://api-astarte.cloud.faberspa.com/appengine/v1"
        )
    )

    _ensure_astarte_token(state)
    print("")
    print("--------------")
    print("Refresh Token:")
    print("--------------")
    print(state.openid_token.refresh_token)
    print("")
    _print_device_info(state)

if __name__ == "__main__":
    _main()
