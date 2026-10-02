import { CalendarEvent, CalendarEventInput, CalendarIdentity, CalendarListQuery, CalendarProvider, CalendarProviderError } from "../integrations/googleCalendar/calendarProvider.js";

export class CalendarService {
  constructor(private readonly provider: CalendarProvider) {}
  listUpcomingEvents(identity: CalendarIdentity, query: CalendarListQuery): Promise<CalendarEvent[]> {
    return this.run(() => this.provider.listUpcomingEvents(identity, query));
  }
  findEventsForLead(identity: CalendarIdentity, email: string): Promise<CalendarEvent[]> {
    return this.run(() => this.provider.findEventsForLead(identity, email));
  }
  getEventDetails(identity: CalendarIdentity, eventId: string): Promise<CalendarEvent | undefined> {
    return this.run(() => this.provider.getEventDetails(identity, eventId));
  }
  connectionStatus(identity: CalendarIdentity): Promise<{ connected: boolean; reauthorizationRequired?: boolean }> {
    return this.run(() => this.provider.connectionStatus(identity));
  }
  createEvent(identity: CalendarIdentity, event: CalendarEventInput, actionId: string): Promise<CalendarEvent> {
    return this.run(() => this.provider.createEvent(identity, event, actionId));
  }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof CalendarProviderError) throw error;
      throw new CalendarProviderError("CALENDAR_UNAVAILABLE", "Calendar data is temporarily unavailable.", 503);
    }
  }
}
