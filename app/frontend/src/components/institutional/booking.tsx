import { ArrowUpRight } from "lucide-react";

const bookingUrl =
  "https://calendar.google.com/calendar/appointments/schedules/AcZssZ3DZwsI1YR155FXCTNp23s_RKjrpdHqzSfqPgT7QS0La4iAsuWFuX2-N0y3yv4DPAF1oSm5f7b4?gv=true";

export function BookingLink({ secondary = false }: { secondary?: boolean }) {
  return (
    <a
      className={secondary ? "ih-button ih-secondary" : "ih-button"}
      href={bookingUrl}
      target="_blank"
      rel="noopener noreferrer"
    >
      Schedule a Meeting <ArrowUpRight size={17} aria-hidden="true" />
    </a>
  );
}
