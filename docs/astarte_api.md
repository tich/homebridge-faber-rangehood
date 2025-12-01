<span align="center">

# Everything we know about the remote/Astarte API for Faber/Franke range hoods

</span>

# Disclaimer

This is all gathered from a packet capture of the Faber Cloud app. The list of API endpoints here may be incomplete

# Foreword

The remote API for these range hoods was implemented (by the manufacturer) using the the Astarte App Engine framework. Therefore it follows all the design choices/idioms of that framework. When you see references to realm/device_id/interface later in this document, know that these are Astarte concepts. For a quick intro to the API structure for Astarte App Engine API, [see here](https://docs.astarte-platform.org/astarte/1.0/api/).

# OpenID Authorization

> Note that the ID and Refresh tokens aren't an Astarte API concept, they're an OAuth/OpenID flow. But I'm documenting them here because you'll need an ID token in order to get an Astarte API JWT token.

The OpenID authorization uses the "authorization_code" flow. The first step in this flow is to submit a POST request to the OAuth authorization endpoint (https://frankeid.b2clogin.com/frankeid.onmicrosoft.com/oauth2/v2.0/authorize) with the username/password of the user. The user typically does that by signing into the web page. The authorzation endpoint then redirects to the given redirection URI (in this case, the only URI that the server allows is the one that uses the mobile app's scheme, which is why we have to setup a scheme handler beforehand).

The redirect URI is also given an authorization code. Using this authorization code, we can submit a POST request to the OAuth token endpoint (https://frankeid.b2clogin.com/frankeid.onmicrosoft.com/oauth2/v2.0/token) in order to get an ID token and a Refresh token.

Note that if the ID token expires (or we don't happen to have one), we can use the Refresh token to get a new ID token (and also a new Refresh token with a brand new expiration date!). This last bit is what allows us to only need a refresh token in this plugin's configuration. We can then get ID and Refresh tokens ad-infinitum.

# Astarte Authorization - User ID

Using an OpenID ID token, we can make a GET request to the Astarte associator to retrieve the user's Astarte User ID:

```
GET https://auth.cloud.faberspa.com/astarte-associator/user_info/faber
Headers: {
    "sso-token": "<OpenID ID Token>"
}
```

The response will look like this:
```
{
    "data": {
        "has_google_smart_home": false,
        "realm": "faber",
        "user_id": "00000000-0000-0000-0000-000000000000"
    }
}
```

> Note that the "realm" given in the response is yet another Astarte App Engine concept, and ideally we should be reading it from this response and using it to construct API URLs. However we just hardcode our URLs to `faber` anyway because I'm not sure that there's another realm supported by this API anyway.

# Astarte Authorization - Device IDs and Token

Now that we have an Astarte User ID, we can query the list of devices associated with this user and also get an Astarte API token:

```
GET https://auth.cloud.faberspa.com/astarte-associator/tokens/faber/users/{user_id}/devices
Headers: {
    "sso-token": "<OpenID ID Token>"
}
```

The response will look like this:
```
{
    "data": {
        "hoods": {
            "devices": [
                {
                    "id": "PINb47...",
                    "timestamp": "2025-10-12T20:42:54Z"
                }
            ],
            "token": "eyJhbG..."
        }
    }
}
```

> At this point, I'm not sure whether the token only applies to range hoods, and I'm also not sure what other kinds of devices are supported

> All requests sent to the Astarte App Engine URL will need to provide the Astarte API JWT token that's returned above inside the request's header like so:
> ```
> "Authorization": "Bearer <Astarte API Token>"
> ```

# Device General Status

This is a generic Astarte App Engine endpoint. It seems to retrieve Astarte connection information for a given device. This information isn't very useful for the homebridge plugin other than the fact that it seems to enumerate all the suported Astarte interfaces.

Request: `GET https://api-astarte.cloud.faberspa.com/appengine/v1/faber/devices/{device_id}`

Response:
```
{
    "data": {
        "aliases": {},
        "attributes": {},
        "connected": true,
        "credentials_inhibited": false,
        "first_credentials_request": "2025-10-12T20:42:35.770Z",
        "first_registration": "2025-10-12T20:42:26.380Z",
        "groups": [],
        "id": "{device_id}",
        "introspection": {
            "com.faberspa.DeviceDetails": {
                "exchanged_bytes": 0,
                "exchanged_msgs": 0,
                "major": 1,
                "minor": 0
            },
            "com.faberspa.connectedhood.AirQuality": {
                "exchanged_bytes": 478,
                "exchanged_msgs": 8,
                "major": 1,
                "minor": 0
            },
            "com.faberspa.connectedhood.AllowedUsers": {
                "exchanged_bytes": 108,
                "exchanged_msgs": 1,
                "major": 1,
                "minor": 0
            },
            "com.faberspa.connectedhood.Control": {
                "exchanged_bytes": 0,
                "exchanged_msgs": 0,
                "major": 1,
                "minor": 0
            },
            "com.faberspa.connectedhood.DeviceInfo": {
                "exchanged_bytes": 715,
                "exchanged_msgs": 10,
                "major": 1,
                "minor": 0
            },
            "com.faberspa.connectedhood.Features": {
                "exchanged_bytes": 13491,
                "exchanged_msgs": 148,
                "major": 1,
                "minor": 0
            },
            "com.faberspa.connectedhood.HoodStatus": {
                "exchanged_bytes": 7074,
                "exchanged_msgs": 97,
                "major": 1,
                "minor": 0
            },
            "com.faberspa.connectedhood.MotorProperties": {
                "exchanged_bytes": 3732,
                "exchanged_msgs": 51,
                "major": 1,
                "minor": 0
            },
            "com.faberspa.connectedhood.TemperatureAndHumidity": {
                "exchanged_bytes": 346,
                "exchanged_msgs": 4,
                "major": 1,
                "minor": 0
            },
            "com.faberspa.connectedpurifier.Control": {
                "exchanged_bytes": 0,
                "exchanged_msgs": 0,
                "major": 1,
                "minor": 0
            },
            "com.faberspa.connectedpurifier.Properties": {
                "exchanged_bytes": 0,
                "exchanged_msgs": 0,
                "major": 1,
                "minor": 0
            },
            "com.faberspa.connectedpurifier.Status": {
                "exchanged_bytes": 394,
                "exchanged_msgs": 6,
                "major": 1,
                "minor": 0
            }
        },
        "last_connection": "2025-10-13T03:42:57.210Z",
        "last_credentials_request_ip": "<ip>",
        "last_disconnection": "2025-10-13T03:42:57.107Z",
        "last_seen_ip": "<ip>",
        "previous_interfaces": [],
        "total_received_bytes": 27871,
        "total_received_msgs": 328
    }
}
```

# Device Info

> I'm not sure what information this interface is getting us

Request: `GET https://api-astarte.cloud.faberspa.com/appengine/v1/faber/devices/{device_id}/interfaces/com.faberspa.connectedhood.DeviceInfo`

Response:
```
{
    "data": {
        "currentIPAddress": "<device local ip (e.g. 192.168.1.67)>",
        "deviceType": "FAIR"
    }
}
```

# Device Details

This interface retrieves the device model. We use this in `get_token.py` so that the user can associate a device ID with a physical device that they have at home.

Request: `GET https://api-astarte.cloud.faberspa.com/appengine/v1/faber/devices/{device_id}/interfaces/com.faberspa.DeviceDetails`

Response:
```
{
    "data": {
        "location": "",
        "modelLine": "STRATUS ISOLA",
        "modelLineInputReliability": 50,
        "type": "HOOD"
    }
}
```

# Device Features

This is a great way to discover all the features that a given device supports. The plugin uses this to determine things like the number of supported light intensities, or light colors.

Request: `GET https://api-astarte.cloud.faberspa.com/appengine/v1/faber/devices/{device_id}/interfaces/com.faberspa.connectedhood.Features`

Response:
```
{
    "data": {
        "auxiliary": {
            "airQualitySensor": false,
            "autoAQSSupport": false,
            "noiseControlModule": false,
            "temperatureSensor": false,
            "upDownMovement": false
        },
        "filters": {
            "fc": {
                "replacementHours": 200
            },
            "fg": {
                "replacementHours": 100
            }
        },
        "lights": {
            "channels": {
                "1": {
                    "dimmerable": true,
                    "intensities": {
                        "0": {
                            "percentage": 60
                        },
                        "1": {
                            "percentage": 45
                        },
                        "2": {
                            "percentage": 30
                        },
                        "3": {
                            "percentage": 20
                        },
                        "4": {
                            "percentage": 0
                        },
                        "5": {
                            "percentage": 100
                        },
                        "6": {
                            "percentage": 75
                        },
                        "7": {
                            "percentage": 50
                        },
                        "8": {
                            "percentage": 25
                        },
                        "9": {
                            "percentage": 0
                        }
                    },
                    "maxIntensity": 2
                },
                "2": {
                    "dimmerable": true,
                    "intensities": {
                        "0": {
                            "percentage": 0
                        },
                        "1": {
                            "percentage": 20
                        },
                        "2": {
                            "percentage": 30
                        },
                        "3": {
                            "percentage": 45
                        },
                        "4": {
                            "percentage": 60
                        },
                        "5": {
                            "percentage": 0
                        },
                        "6": {
                            "percentage": 25
                        },
                        "7": {
                            "percentage": 50
                        },
                        "8": {
                            "percentage": 75
                        },
                        "9": {
                            "percentage": 100
                        }
                    },
                    "maxIntensity": 4
                }
            },
            "tunableWhite": {
                "availableColorTemperatureLevels": 5,
                "channels": {
                    "1": {
                        "intensities": {
                            "0": {
                                "0": {
                                    "percentage": 60
                                },
                                "1": {
                                    "percentage": 45
                                },
                                "2": {
                                    "percentage": 30
                                },
                                "3": {
                                    "percentage": 20
                                },
                                "4": {
                                    "percentage": 0
                                }
                            },
                            "1": {
                                "0": {
                                    "percentage": 100
                                },
                                "1": {
                                    "percentage": 75
                                },
                                "2": {
                                    "percentage": 50
                                },
                                "3": {
                                    "percentage": 25
                                },
                                "4": {
                                    "percentage": 0
                                }
                            }
                        }
                    },
                    "2": {
                        "intensities": {
                            "0": {
                                "0": {
                                    "percentage": 0
                                },
                                "1": {
                                    "percentage": 20
                                },
                                "2": {
                                    "percentage": 30
                                },
                                "3": {
                                    "percentage": 45
                                },
                                "4": {
                                    "percentage": 60
                                }
                            },
                            "1": {
                                "0": {
                                    "percentage": 0
                                },
                                "1": {
                                    "percentage": 25
                                },
                                "2": {
                                    "percentage": 50
                                },
                                "3": {
                                    "percentage": 75
                                },
                                "4": {
                                    "percentage": 100
                                }
                            }
                        }
                    }
                },
                "enabled": true
            }
        }
    }
}
```

# Motor Properties

This is another interface that the plugin uses to determine supported features. This one focuses on the fan itself.

Request: `GET https://api-astarte.cloud.faberspa.com/appengine/v1/faber/devices/{device_id}/interfaces/com.faberspa.connectedhood.MotorProperties`

Response:
```
{
    "data": {
        "delay": 1800,
        "intensive": {
            "1": {
                "duration": 360,
                "speed": 4
            },
            "2": {
                "duration": 360,
                "speed": 4
            }
        },
        "maxFanSpeed": 3,
        "mode24h": {
            "alternate": true,
            "duration": 1440,
            "speeds": {
                "1": {
                    "duration": 600,
                    "speed": 1
                },
                "2": {
                    "duration": 3000,
                    "speed": 0
                }
            }
        },
        "speeds": {
            "0": {
                "percentage": 255
            },
            "1": {
                "percentage": 255
            },
            "2": {
                "percentage": 255
            },
            "3": {
                "percentage": 255
            },
            "4": {
                "percentage": 255
            }
        }
    }
}
```

# Hood Status

This interface retrieves the status of all of the hood's supported features. The plugin uses this data to update the status of all of the controls.

Request: `GET https://api-astarte.cloud.faberspa.com/appengine/v1/faber/devices/{device_id}/interfaces/com.faberspa.connectedhood.HoodStatus`

Response:
```
{
    "data": {
        "countdownEnd": {
            "reception_timestamp": "2025-10-13T03:42:57.914Z",
            "timestamp": "2025-10-13T03:42:57.914Z",
            "value": 0
        },
        "fan": {
            "speed": {
                "reception_timestamp": "2025-10-13T21:24:21.685Z",
                "timestamp": "2025-10-13T21:24:21.685Z",
                "value": 0
            }
        },
        "filters": {
            "fc": {
                "hoursUntilReplacement": {
                    "reception_timestamp": "2025-10-13T03:42:57.750Z",
                    "timestamp": "2025-10-13T03:42:57.750Z",
                    "value": 200
                }
            },
            "fg": {
                "hoursUntilReplacement": {
                    "reception_timestamp": "2025-10-13T21:07:41.169Z",
                    "timestamp": "2025-10-13T21:07:41.169Z",
                    "value": 95
                }
            }
        },
        "lights": {
            "channels": {
                "1": {
                    "intensity": {
                        "reception_timestamp": "2025-10-13T20:19:29.291Z",
                        "timestamp": "2025-10-13T20:19:29.291Z",
                        "value": 0
                    }
                },
                "2": {
                    "intensity": {
                        "reception_timestamp": "2025-10-13T03:42:57.750Z",
                        "timestamp": "2025-10-13T03:42:57.750Z",
                        "value": 2
                    }
                }
            }
        },
        "operatingStatus": {
            "reception_timestamp": "2025-10-13T03:42:57.748Z",
            "timestamp": "2025-10-13T03:42:57.748Z",
            "value": "normal"
        }
    }
}
```

# Control

This is the interface that allows us to control the hood (e.g. turn on/off the lights). To that end, we use the same paths as the ones returned by the Hood Status interface above. For example, to set the light intensity to 1 we would `POST https://api-astarte.cloud.faberspa.com/appengine/v1/faber/devices/{device_id}/interfaces/com.faberspa.connectedhood.Control/lights/channels/1/intensity` with content-type `application/json` and the following data:
```
{
    "data": 1
}
```