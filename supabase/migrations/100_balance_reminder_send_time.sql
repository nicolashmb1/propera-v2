-- Configurable local send time for balance-triggered rent reminders (portal Settings).

alter table balance_reminder_settings
  add column if not exists send_hour smallint not null default 10
    check (send_hour >= 0 and send_hour <= 23),
  add column if not exists send_minute smallint not null default 0
    check (send_minute >= 0 and send_minute <= 59);

comment on column balance_reminder_settings.send_hour is
  'Local hour (0–23, org PROPERA_TZ) when due-day reminders may send.';
comment on column balance_reminder_settings.send_minute is
  'Local minute (0–59) when due-day reminders may send. Cron runs every 15 minutes.';
