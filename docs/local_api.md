<span align="center">

# Everything we know about the local (not cloud-based) API for Faber/Franke range hoods

</span>

# Foreword

There's not much that we know about this local API. And I'm not sure whether it could fully replace the remote API (though I wish it could). More investigation/probing is required here.

# Device Firmware Versions

This request retrieves the firmware and framework versions for the microcontroller on the device. At least the Stratus Isola hood uses an ESP32 chip with the [esp-idf](https://github.com/espressif/esp-idf) and [Astarte](https://github.com/astarte-platform/astarte) frameworks.

Request: `GET http://<ip>/v1/devData`

Response:
```
{
    "data": {
        "IDF":"v3.3.1-209-gcc34d5a5b-dirty", "dev": "Faber Fair ver. 2.2.22256", "AST": "SDK 0.11.1"
    }
}
```

# Device Status

This endpoint **does not** return the actual status of individual features of the device. It's mostly just a general status query.

Request: `GET http://<ip>/v1/status`

Response:
```
{
    "data": {
        "device_id":"<device id>","has_secret":true,"ip":"<ip>","conn_state":true,"realm":"faber"
    }
}
```

# Unknown/Untested endpoints

> The following endpoints are all unverified. Either because they're 'risky' or because they didn't work.

1. `DELETE http://<ip>/v1/hoodData`
    a. I believe this request would unpair the device from the Astarte remote service
    b. This one is untested
2. `DELETE http://<ip>/v1/reset`
    a. This request should factory-reset the hood
    b. I'm not sure, but this *might* require some data to be sent along?
    c. This is untested
3. `POST http://<ip>/v1/wifiCredentials`
    a. This request should set the WiFi credentials for the hood
    b. The request body should be of the form `{"ssid": "<ssid>", "passphrase": "<pass>"}`
    c. This is untested
4. `POST http://<ip>/v1/credentialsSecret`
    a. I believe this request would pair the device with the Astarte remote service
    b. This is untested
5. `POST/GET http://<ip>/v1/fan/speed`, `POST/GET http://<ip>/v1/lights/channels/<n>/intensity`, `POST/GET v1/countdownEnd`
    a. Set/Get the fan speed
    b. These requests did not work when I tried them. Unsure if they require the device to be unpaired from Astarte
6. `POST http://<ip>/v1/hood/active`
    a. Set hood status (turn on/off?)
    b. This request did not work when I tried it. Unsure if it requires the device to be unpaired from Astarte
