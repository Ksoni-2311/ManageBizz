import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { calendarStatusAfterApiError, gmailStatusAfterApiError } from "../services/manageBizzClient.js";

describe("Gmail frontend status after API authorization errors", () => {
  it("requires reconnection after an expired token or confirmed missing scope", () => {
    assert.equal(gmailStatusAfterApiError("EMAIL_AUTH_EXPIRED"), "reauthorization_required");
    assert.equal(gmailStatusAfterApiError("EMAIL_AUTH_REQUIRED"), "reauthorization_required");
  });

  it("shows access denial separately from unknown API failures", () => {
    assert.equal(gmailStatusAfterApiError("EMAIL_ACCESS_DENIED"), "access_denied");
    assert.equal(gmailStatusAfterApiError("EMAIL_API_ERROR"), "unavailable");
    assert.equal(gmailStatusAfterApiError("EMAIL_NOT_CONNECTED"), "disconnected");
  });

  it("maps Calendar authorization errors to the same explicit connection states", () => {
    assert.equal(calendarStatusAfterApiError("CALENDAR_AUTH_EXPIRED"), "reauthorization_required");
    assert.equal(calendarStatusAfterApiError("CALENDAR_AUTH_REQUIRED"), "reauthorization_required");
    assert.equal(calendarStatusAfterApiError("CALENDAR_ACCESS_DENIED"), "access_denied");
    assert.equal(calendarStatusAfterApiError("CALENDAR_API_ERROR"), "unavailable");
    assert.equal(calendarStatusAfterApiError("CALENDAR_NOT_CONNECTED"), "disconnected");
  });

  it("keeps Gmail and Calendar integration cards free of mailbox and event records", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const gmailStart = app.indexOf('<section className="panel gmail-panel">');
    const calendarStart = app.indexOf('<section className="panel calendar-panel">', gmailStart);
    const overviewStart = app.indexOf('<section className="overview-grid"', calendarStart);
    assert.ok(gmailStart >= 0 && calendarStart > gmailStart && overviewStart > calendarStart);
    const gmailCard = app.slice(gmailStart, calendarStart);
    const calendarCard = app.slice(calendarStart, overviewStart);
    assert.doesNotMatch(gmailCard, /emailActivity|subject|sender|\.from|sentAt|email body/i);
    assert.doesNotMatch(calendarCard, /calendarEvents|attendees|description|location|startTime|endTime|event title/i);
    assert.doesNotMatch(app, /getEmailActivity|getUpcomingCalendarEvents|email\/activity|calendar\/events\/upcoming/);
  });
});
