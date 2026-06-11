-- Org-wide broadcast SMS header/footer templates (Communication Engine + rent reminders).

alter table organizations
  add column if not exists comm_sms_header_template text not null default '',
  add column if not exists comm_sms_footer_template text not null default '';

comment on column organizations.comm_sms_header_template is
  'Optional broadcast SMS header; supports {brand}, {building}, {sender_label}, etc.';
comment on column organizations.comm_sms_footer_template is
  'Optional broadcast SMS footer before STOP line; empty = default sender sign-off.';
