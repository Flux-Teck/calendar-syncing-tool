const fs = require("fs");
const readline = require("readline");
const google = require("googleapis");
const googleAuth = require("google-auth-library");
const axios = require("axios");
const moment = require("moment");

const calendar = google.calendar("v3");

let rateLimitTimeout = 333; // in milliseconds
let rateExceededDelay = 2; // in minutes
const updateInterval = 30; // in minutes

// If modifying these scopes, delete your previously saved credentials
// at ~/.credentials/calendar-nodejs-quickstart.json
const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const TOKEN_DIR =
  (process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE) +
  "/.credentials/";
const TOKEN_PATH = TOKEN_DIR + "calendar-nodejs-quickstart.json";

// Load client secrets from a local file.
fs.readFile("client_secret.json", function processClientSecrets(err, content) {
  if (err) {
    console.info("Error loading client secret file: " + err);
    return;
  }
  // Authorize a client with the loaded credentials, then call the
  // Google Calendar API.
  authorize(JSON.parse(content), refreshInterval);
});

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 *
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
authorize = (credentials, callback) => {
  const clientSecret = credentials.installed.client_secret;
  const clientId = credentials.installed.client_id;
  const redirectUrl = credentials.installed.redirect_uris[0];
  const auth = new googleAuth();
  let oauth2Client = new auth.OAuth2(clientId, clientSecret, redirectUrl);

  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, function(err, token) {
    if (err) {
      getNewToken(oauth2Client, callback);
    } else {
      oauth2Client.credentials = JSON.parse(token);
      callback(oauth2Client);
    }
  });
};

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 *
 * @param {google.auth.OAuth2} oauth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback to call with the authorized
 *     client.
 */
getNewToken = (oauth2Client, callback) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES
  });
  console.info("Authorize this app by visiting this url: ", authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  rl.question("Enter the code from that page here: ", function(code) {
    rl.close();
    oauth2Client.getToken(code, function(err, token) {
      if (err) {
        console.info("Error while trying to retrieve access token", err);
        return;
      }
      oauth2Client.credentials = token;
      storeToken(token);
      callback(oauth2Client);
    });
  });
};

/**
 * Store token to disk be used in later program executions.
 *
 * @param {Object} token The token to store to disk.
 */
storeToken = token => {
  try {
    fs.mkdirSync(TOKEN_DIR);
  } catch (err) {
    if (err.code != "EEXIST") {
      throw err;
    }
  }
  fs.writeFile(TOKEN_PATH, JSON.stringify(token));
  console.info("Token stored to " + TOKEN_PATH);
};

// This function is used to refresh the events on a given interval
refreshInterval = oauth2Client => {
  console.info("");
  console.info("===============================");
  console.info("Calendar syncing tool started");
  console.info("===============================");

  // This makes a call to sunmountain center to get the list of reservations
  // It then creates an array of the room names that are currently on the reservations list
  // Most of the code is to remove the duplicate room names
  axios
    .get(
      `https://sunmountaincenter.secure.retreat.guru/api/v1/registrations?token=${process.env.RETREAT_GURU_TOKEN}limit=0&min_stay=${moment()
        .subtract(3, "days")
        .format("YYYY-MM-DD")}&max_stay=${moment()
        .add(6, "months")
        .format("YYYY-MM-DD")}`
    )
    .then(res => {
      const registrations = res.data;
      console.info(
        "Number of registration from retreat guru: %s",
        registrations.length
      );

      let seenRoom = {};
      const roomList = res.data
        .filter(registration => {
          if (seenRoom[registration.room] !== true) {
            seenRoom[registration.room] = true;
            return registration.room;
          }
        })
        .map(registration => {
          return registration.room;
        });

      calendar.calendarList.list(
        {
          auth: oauth2Client,
          maxResults: 50
        },
        (err, response) => {
          if (err) {
            console.info("Error while retrieving calendar list: %s", err);
            return;
          }

          const calendarList = response.items;

          const primary = calendarList.filter(
            calendar => {
              if (
                calendar.primary
              ) {
                return calendar;
              }
            }
          );
          const primaryCalendar = primary[0];

          // Once we get the room names we map over the list to refresh the events for each room

          // refreshMaster is a function that places all of the reservations into a single calendar
          // regreshMaster is commented out because it wasn't necessary and we kept hitting Google's Rate limit

          // refreshEvents is a function that places all of the reseravtions into calendars organized by room name.
          // For example a if we got a room names "Room #2" from Retreat Guru then it would have it's own calendar with all events under that name placed there

          // refreshMaster(oauth2Client, registrations, primaryCalendar, () => {
          refreshEvents(oauth2Client, calendarList, registrations, roomList, 0);
          // });
        }
      );
    });
};

refreshMaster = (oauth2Client, registrations, primaryCalendar, callback) => {
  let calendarId = primaryCalendar.id;
  let calendarName = primaryCalendar.summary;

  listEvents(oauth2Client, calendarId, "primary", (events, skipTwo) => {
    if (skipTwo) {
      // second reason to skip creating a calendar is if it already exists
      skip = skipTwo;
    }
    deleteEvents(oauth2Client, events, calendarId, quotaExceeded => {
      createEvents(
        oauth2Client,
        registrations,
        calendarId,
        calendarName,
        true,
        quotaExceeded => {
          callback();
        }
      );
    });
  });
};

refreshEvents = (
  oauth2Client,
  calendarList,
  registrations,
  roomList,
  index
) => {
  const roomName = roomList[index];

  let calendarId = "";
  let calendarName = "";
  calendarList.map(calendar => {
    if (calendar.summary === roomName) {
      calendarId = calendar.id;
      calendarName = calendar.summary;
    }
  });

  let skip = false;
  if (calendarName && calendarId) {
    skip = true; // if these values exist then skip creating a calendar because it already exists
  }

  listEvents(oauth2Client, calendarId, roomName, (events, skipTwo) => {
    if (skipTwo) {
      // second reason to skip creating a calendar is if it already exists
      skip = skipTwo;
    }
    createCalendar(
      oauth2Client,
      roomName,
      skip,
      (newCalendarId, quotaExceeded) => {
        if (newCalendarId) {
          calendarId = newCalendarId;
        }
        deleteEvents(oauth2Client, events, calendarId, quotaExceeded => {
          createEvents(
            oauth2Client,
            registrations,
            calendarId,
            calendarName,
            false,
            quotaExceeded => {
              if (index < roomList.length - 1) {
                setTimeout(() => {
                  refreshEvents(
                    oauth2Client,
                    calendarList,
                    registrations,
                    roomList,
                    index + 1
                  );
                }, rateLimitTimeout);
              } else {
                console.info("===============================");
                console.info("Next update in %s minutes", updateInterval);
                console.info("===============================");
                setTimeout(() => {
                  console.info("");
                  refreshInterval(oauth2Client);
                }, 1000 * 60 * updateInterval);
              }
            }
          );
        });
      }
    );
  });
};

/**
 * Lists up to 200 events on the user's primary calendar.
 *
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */
listEvents = (auth, calendarId, roomName, callback) => {
  calendar.events.list(
    {
      auth: auth,
      calendarId: calendarId,
      maxResults: 200,
      singleEvents: true,
      orderBy: "startTime"
    },
    function(err, response) {
      setTimeout(() => {
        //set timeout for every new call to google to stay under rate limit

        if (err) {
          console.info("Error while retrieving event list: " + err);
          callback(null, false);
          return;
        }
        const events = response.items;
        if (events.length == 0) {
          console.info(
            `Number of events found in Google Calendar for ${roomName}: ${
              events.length
            }`
          );
          callback(null, true);
        } else {
          console.info(
            `Number of events found in Google Calendar for ${roomName}: ${
              events.length
            }`
          );
          callback(events, true);
        }
      }, rateLimitTimeout);
    }
  );
};

createCalendar = (auth, roomName, skip, callback) => {
  if (skip) {
    callback();
  } else {
    calendar.calendars.insert(
      {
        auth: auth,
        resource: {
          summary: roomName
        }
      },
      function(err, response) {
        setTimeout(() => {
          //set timeout for every new call to google to stay under rate limit

          if (err) {
            console.info("Error while creating a calendar: " + err);
            if (err.errors[0].reason === "quotaExceeded") {
              callback(null, true);
            }
            return;
          }
          console.info("Calendar created for: " + response.summary);
          callback(response.id);
        }, rateLimitTimeout);
      }
    );
  }
};

deleteEvents = (auth, events, calendarId, callback) => {
  if (events) {
    deleteEvent(auth, events, calendarId, callback, 0);
  } else {
    console.info("Skip deleting events for the given room name");
    callback();
  }
};

deleteEvent = (auth, events, calendarId, callback, index) => {
  if (events.length > 0) {
    calendar.events.delete(
      {
        auth: auth,
        calendarId: calendarId,
        eventId: events[index].id
      },
      (err, response) => {
        setTimeout(() => {
          //set timeout for every new call to google to stay under rate limit

          if (err) {
            if (err.code === 403) {
              rateExceededDelay = rateExceededDelay * 2;
              console.info(
                "* Next event delayed for: %s minutes",
                rateExceededDelay
              );
              setTimeout(() => {
                deleteEvent(auth, events, calendarId, callback, index);
              }, 1000 * 60 * rateExceededDelay);
            }
          } else if (index < events.length - 1) {
            if (rateExceededDelay > 2) {
              rateExceededDelay = rateExceededDelay / 2;
            }
            deleteEvent(auth, events, calendarId, callback, index + 1);
          } else {
            console.info("- Deleted all events");
            if (rateExceededDelay > 2) {
              rateExceededDelay = rateExceededDelay / 2;
            }
            callback();
          }
        }, rateLimitTimeout);
      }
    );
  } else {
    callback();
  }
};

createEvents = (
  auth,
  registrations,
  calendarId,
  calendarName,
  calendarPrimary,
  callback
) => {
  // create a list of reservations for the given room
  const shortList = registrations.filter(registration => {
    if (registration.room === calendarName || calendarPrimary) {
      if (registration.room_id !== 0) {
        return true;
      }
    }
    return false;
  });

  if (shortList.length > 0) {
    process.stdout.write("- Number of events created: 0");
    createEvent(shortList, auth, calendarId, calendarName, 0, callback);
  } else {
    callback();
  }
};

arrivalTimeframe = registration => {
  if (registration.questions.arrival_timeframe.startsWith("200")) {
    return moment(`${registration.start_date} 13:00:00.000`).format();
  } else if (registration.questions.arrival_timeframe.startsWith("230")) {
    return moment(`${registration.start_date} 13:30:00.000`).format();
  } else if (registration.questions.arrival_timeframe.startsWith("300")) {
    return moment(`${registration.start_date} 14:00:00.000`).format();
  } else if (registration.questions.arrival_timeframe.startsWith("330")) {
    return moment(`${registration.start_date} 14:30:00.000`).format();
  } else {
    return moment(`${registration.start_date} 13:00:00.000`).format();
  }
};

createEvent = (
  registrations,
  auth,
  calendarId,
  calendarName,
  index,
  callback
) => {
  const event = {
    summary:
      registrations[index].program === "Personal Booking"
        ? `${registrations[index].room} - ${registrations[index].first_name} ${
            registrations[index].last_name
          } for B&B`
        : `${registrations[index].room} - ${registrations[index].program} - ${
            registrations[index].first_name
          } ${registrations[index].last_name} for retreats`,
    location: `328 El Paso Blvd`,
    description: description(registrations[index]),
    start: {
      dateTime: arrivalTimeframe(registrations[index]),
      timeZone: "America/Denver"
    },
    end: {
      dateTime: moment(`${registrations[index].end_date} 23:00:00.000`)
        .subtract(1, "days")
        .format(),
      timeZone: "America/Denver"
    },
    recurrence: []
  };
  calendar.events.insert(
    {
      auth: auth,
      calendarId: calendarId,
      resource: event
    },
    (err, event) => {
      setTimeout(() => {
        //set timeout for every new call to google to stay under rate limit

        if (err) {
          process.stdout.write("\n");
          console.info(
            "There was an error contacting the Calendar service: " + err
          );
          if (err.code === 403) {
            rateExceededDelay = rateExceededDelay * 2;
            console.info(
              "* Next event delayed for: %s minutes",
              rateExceededDelay
            );
            setTimeout(() => {
              createEvent(
                registrations,
                auth,
                calendarId,
                calendarName,
                index,
                callback
              );
            }, 1000 * 60 * rateExceededDelay);
          }
        } else if (index < registrations.length - 1) {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0, null);
          process.stdout.write("- Number of events created: " + (index + 1));
          if (rateExceededDelay > 2) {
            rateExceededDelay = rateExceededDelay / 2;
          }
          createEvent(
            registrations,
            auth,
            calendarId,
            calendarName,
            index + 1,
            callback
          );
        } else {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0, null);
          process.stdout.write("- Number of events created: " + (index + 1));
          process.stdout.write("\n");
          console.info("- Created all events");
          if (rateExceededDelay > 2) {
            rateExceededDelay = rateExceededDelay / 2;
          }
          callback();
        }
      }, rateLimitTimeout);
    }
  );
};

description = registration => {
  let description = "";
  description += `${registration.nights} Night${isPlural(registration.nights)}`;

  Object.keys(registration.questions).map(key => {
    if (
      registration.questions[key] !== "" &&
      typeof registration.questions[key] !== "object"
    ) {
      description += `\n${formatKey(key)}: ${registration.questions[key]}`;
    }
  });

  return description;
};

formatKey = key => {
  let newKey = key.replace("_", " ");
  newKey = toTitleCase(newKey);
  return newKey;
};

function toTitleCase(str) {
  return str.replace(/\w\S*/g, function(txt) {
    return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
  });
}

isPlural = numOfNights => {
  if (numOfNights > 1) {
    return "s";
  } else {
    return "";
  }
};
