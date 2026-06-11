-- Optional header/footer lines wrapped around each rent-reminder step body (before broadcast sign-off).

alter table balance_reminder_settings
  add column if not exists message_header text not null default '',
  add column if not exists message_footer text not null default '';

comment on column balance_reminder_settings.message_header is
  'Optional line prepended to every rent-reminder SMS body (before step copy).';
comment on column balance_reminder_settings.message_footer is
  'Optional line appended after step copy and before automatic sign-off + STOP.';
