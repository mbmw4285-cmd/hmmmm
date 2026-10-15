/*
  VERDIX ESP32 firmware
  Matches VERDIX/server.js endpoints:
    POST /api/trigger
    POST /api/bin-status
    POST /sort  (ESP32 receives this from the Node server)

  Install library: ESP32Servo (Library Manager).
  Board: ESP32 Dev Module.

  IMPORTANT:
  - Run the Node backend on a computer on the SAME Wi-Fi as this ESP32.
    Set BACKEND_URL to that computer's LAN address, e.g. http://192.168.1.10:3000
    A Render-hosted server cannot directly call a private 192.168.x.x ESP32.
  - HC-SR04 ECHO must go through a voltage divider before reaching ESP32 GPIO19.
  - Servo angles are starting values. Calibrate them for your physical carousel/flaps.
*/

#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <ESP32Servo.h>

// ---------- CHANGE THESE ----------
const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// IP address of the laptop running "npm start", NOT the Render URL.
const char* BACKEND_URL = "http://192.168.1.10:3000";

// Must match DEVICE_TOKEN in the backend .env, or leave both blank.
const char* DEVICE_TOKEN = "";

// ---------- PIN CONFIGURATION ----------
const int IR_PIN = 13;          // IR sensor OUT
const int US_TRIG_PIN = 18;     // HC-SR04 TRIG
const int US_ECHO_PIN = 19;     // HC-SR04 ECHO via voltage divider

const int CAROUSEL_SERVO_PIN = 25; // Servo 1: rotate four-bin carousel
const int HOPPER_SERVO_PIN = 26;   // Servo 2: hopper flap open/close
const int INLET_SERVO_PIN = 27;    // Servo 3: input lid/gate (if fitted)

// ---------- CALIBRATE THESE ANGLES ----------
const int BIN_ANGLE[4] = {20, 65, 115, 160};
const int HOPPER_CLOSED = 10;
const int HOPPER_OPEN = 85;
const int INLET_OPEN = 85;
const int INLET_CLOSED = 10;

// Mapping must match the website/server: PLASTIC=1, PAPER=2, METAL=3, ORGANIC=4.
const char* MATERIALS[4] = {"PLASTIC", "PAPER", "METAL", "ORGANIC"};

const float BIN_FULL_CM = 8.0;          // match BIN_FULL_CM in backend
const unsigned long STATUS_MAX_AGE_MS = 60000;
const unsigned long BIN_SWEEP_INTERVAL_MS = 30000;
const unsigned long IR_DEBOUNCE_MS = 1200;

Servo carouselServo;
Servo hopperServo;
Servo inletServo;
WebServer deviceServer(80);

struct BinReading {
  float distanceCm;
  unsigned long updatedAt;
  bool valid;
};
BinReading binReadings[4];

bool sorting = false;
bool sweeping = false;
int currentBinIndex = 0;
int lastIrState = HIGH;
unsigned long lastIrTriggerMs = 0;
unsigned long lastSweepMs = 0;

// ---------- HELPERS ----------
String backendBase() {
  String s = String(BACKEND_URL);
  while (s.endsWith("/")) s.remove(s.length() - 1);
  return s;
}

void addDeviceToken(HTTPClient& http) {
  if (strlen(DEVICE_TOKEN) > 0) {
    http.addHeader("X-Device-Token", DEVICE_TOKEN);
  }
}

bool postBackendJson(const String& endpoint, const String& jsonBody) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  http.setConnectTimeout(2500);
  http.setTimeout(3000);
  const String url = backendBase() + endpoint;

  if (!http.begin(url)) return false;
  http.addHeader("Content-Type", "application/json");
  addDeviceToken(http);

  int code = http.POST(jsonBody);
  String response = http.getString();
  http.end();

  Serial.printf("POST %s -> HTTP %d %s\n", endpoint.c_str(), code, response.c_str());
  return code >= 200 && code < 300;
}

float readDistanceCm() {
  digitalWrite(US_TRIG_PIN, LOW);
  delayMicroseconds(3);
  digitalWrite(US_TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(US_TRIG_PIN, LOW);

  // 30 ms timeout avoids a long block if no echo is returned.
  unsigned long duration = pulseIn(US_ECHO_PIN, HIGH, 30000);
  if (duration == 0) return -1.0;
  float cm = duration * 0.0343f / 2.0f;
  if (cm < 2.0f || cm > 400.0f) return -1.0;
  return cm;
}

void reportBinReading(int index, float cm) {
  if (index < 0 || index > 3 || cm < 0) return;

  binReadings[index].distanceCm = cm;
  binReadings[index].updatedAt = millis();
  binReadings[index].valid = true;

  String body = "{\"material\":\"";
  body += MATERIALS[index];
  body += "\",\"distance_cm\":";
  body += String(cm, 1);
  body += "}";

  postBackendJson("/api/bin-status", body);

  Serial.printf("%s bin distance: %.1f cm (%s)\n",
                MATERIALS[index], cm, cm <= BIN_FULL_CM ? "FULL" : "OK");
}

bool binIsSafeToUse(int index) {
  if (index < 0 || index > 3) return false;
  if (!binReadings[index].valid) return false;
  if (millis() - binReadings[index].updatedAt > STATUS_MAX_AGE_MS) return false;
  return binReadings[index].distanceCm > BIN_FULL_CM;
}

int materialIndexFromBody(String body) {
  body.toUpperCase();
  for (int i = 0; i < 4; i++) {
    if (body.indexOf(String("\"MATERIAL\"") + ":" + "\"" + MATERIALS[i] + "\"") >= 0 ||
        body.indexOf(String("\"" ) + MATERIALS[i] + "\"") >= 0) {
      return i;
    }
  }
  return -1;
}

void moveToBin(int index) {
  currentBinIndex = index;
  carouselServo.write(BIN_ANGLE[index]);
  delay(750); // allow carousel to settle before measuring
}

void handleSortRequest() {
  if (sorting || sweeping) {
    deviceServer.send(409, "application/json", "{\"ok\":false,\"error\":\"Device busy\"}");
    return;
  }

  String body = deviceServer.arg("plain");
  int index = materialIndexFromBody(body);
  if (index < 0) {
    deviceServer.send(400, "application/json", "{\"ok\":false,\"error\":\"Unknown material\"}");
    return;
  }

  sorting = true;
  inletServo.write(INLET_CLOSED);
  delay(250);

  moveToBin(index);

  // Re-measure the selected bin immediately before opening the hopper.
  float cm = readDistanceCm();
  if (cm >= 0) reportBinReading(index, cm);

  if (!binIsSafeToUse(index)) {
    inletServo.write(INLET_OPEN);
    sorting = false;
    deviceServer.send(409, "application/json",
      "{\"ok\":false,\"error\":\"Bin is full or its distance reading is missing/stale. Hopper kept closed.\"}");
    return;
  }

  hopperServo.write(HOPPER_OPEN);
  delay(900);
  hopperServo.write(HOPPER_CLOSED);
  delay(500);
  inletServo.write(INLET_OPEN);

  sorting = false;
  deviceServer.send(200, "application/json",
    "{\"ok\":true,\"message\":\"Waste sorted; hopper closed\"}");
  Serial.printf("Sorted %s into bin %d\n", MATERIALS[index], index + 1);
}

void sweepBinLevels() {
  if (sorting || sweeping || WiFi.status() != WL_CONNECTED) return;

  sweeping = true;
  inletServo.write(INLET_CLOSED);
  hopperServo.write(HOPPER_CLOSED);
  delay(250);

  int originalIndex = currentBinIndex;
  for (int i = 0; i < 4; i++) {
    moveToBin(i);
    float cm = readDistanceCm();
    if (cm >= 0) reportBinReading(i, cm);
    else Serial.printf("No valid ultrasonic reading for %s\n", MATERIALS[i]);
    delay(150);
  }

  moveToBin(originalIndex);
  inletServo.write(INLET_OPEN);
  sweeping = false;
  lastSweepMs = millis();
}

void setup() {
  Serial.begin(115200);
  pinMode(IR_PIN, INPUT_PULLUP);
  pinMode(US_TRIG_PIN, OUTPUT);
  pinMode(US_ECHO_PIN, INPUT);
  digitalWrite(US_TRIG_PIN, LOW);

  for (int i = 0; i < 4; i++) {
    binReadings[i].distanceCm = -1;
    binReadings[i].updatedAt = 0;
    binReadings[i].valid = false;
  }

  // Use ESP32Servo, not the standard AVR Servo library.
  carouselServo.setPeriodHertz(50);
  hopperServo.setPeriodHertz(50);
  inletServo.setPeriodHertz(50);
  carouselServo.attach(CAROUSEL_SERVO_PIN, 500, 2500);
  hopperServo.attach(HOPPER_SERVO_PIN, 500, 2500);
  inletServo.attach(INLET_SERVO_PIN, 500, 2500);

  hopperServo.write(HOPPER_CLOSED);
  inletServo.write(INLET_OPEN);
  carouselServo.write(BIN_ANGLE[0]);
  delay(800);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi not connected. Check SSID/password.");
  }

  deviceServer.on("/sort", HTTP_POST, handleSortRequest);
  deviceServer.on("/health", HTTP_GET, []() {
    deviceServer.send(200, "application/json", "{\"ok\":true,\"device\":\"VERDIX ESP32\"}");
  });
  deviceServer.begin();
  Serial.println("VERDIX ESP32 HTTP server started on port 80");
}

void loop() {
  deviceServer.handleClient();

  // Standard IR modules commonly go LOW when an object is detected.
  // If your module is active HIGH, change LOW to HIGH below.
  int irState = digitalRead(IR_PIN);
  if (!sorting && !sweeping &&
      irState == LOW && lastIrState != LOW &&
      millis() - lastIrTriggerMs >= IR_DEBOUNCE_MS) {
    lastIrTriggerMs = millis();
    Serial.println("IR detected waste; notifying backend...");
    postBackendJson("/api/trigger", "{}");
  }
  lastIrState = irState;

  // One HC-SR04 measures one bin at a time. The carousel is indexed through
  // all four bins while the inlet is closed, then returned to its previous position.
  if (!sorting && !sweeping &&
      (lastSweepMs == 0 || millis() - lastSweepMs >= BIN_SWEEP_INTERVAL_MS)) {
    sweepBinLevels();
  }

  delay(5);
}
