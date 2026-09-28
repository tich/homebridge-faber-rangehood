export const OPENID_CLIENT_ID = '12af9176-4d94-4919-950b-c26a8cd655db';
export const OPENID_AUTH_URL = 'https://frankeid.b2clogin.com/frankeid.onmicrosoft.com/oauth2/v2.0';
export const OPENID_TOKEN_ENDPOINT = '/token';
export const OPENID_TOKEN_EXTRA_PARAMETERS = { p: 'B2C_1A_signup_signin_localonly_Faber' };

export const ASTARTE_REALM = 'faber';
export const ASTARTE_AUTH_URL = 'https://auth.cloud.faberspa.com';
export const ASTARTE_USER_INFO_ENDPOINT = '/astarte-associator/user_info';
export const ASTARTE_TOKEN_ENDPOINT = '/astarte-associator/tokens';

export const ASTARTE_API_URL = 'https://api-astarte.cloud.faberspa.com';
export const ASTARTE_API_ENDPOINT = '/appengine/v1';
// Astarte's real-time channels: a Phoenix WebSocket, where a client joins a room and watches devices' data
export const ASTARTE_CHANNELS_URL = 'wss://api-astarte.cloud.faberspa.com/appengine/v1/socket/websocket';

export const ASTARTE_INTERFACE_DEVICE_DETAILS = 'com.faberspa.DeviceDetails';
export const ASTARTE_INTERFACE_HOOD_STATUS = 'com.faberspa.connectedhood.HoodStatus';
export const ASTARTE_INTERFACE_HOOD_FEATURES = 'com.faberspa.connectedhood.Features';
export const ASTARTE_INTERFACE_HOOD_MOTOR_PROPERTIES = 'com.faberspa.connectedhood.MotorProperties';
export const ASTARTE_INTERFACE_HOOD_CONTROL = 'com.faberspa.connectedhood.Control';
// A healthy response takes well under a second, so this is generous, while limiting how long a hung request blocks
export const REQUEST_TIMEOUT_MS = 10 * 1000;
