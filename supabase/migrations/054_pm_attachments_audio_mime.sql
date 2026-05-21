-- Allow voice notes in pm-attachments (Propera Chat portal-chat-audio/* uploads).
-- @see propera-app/src/app/api/portal/chat-audio-upload/route.ts

update storage.buckets
set
  allowed_mime_types = array[
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
    'image/heif',
    'application/pdf',
    'audio/webm',
    'audio/ogg',
    'audio/opus',
    'audio/mpeg',
    'audio/mp3',
    'audio/mp4',
    'audio/wav',
    'audio/x-wav',
    'audio/aac',
    'audio/flac'
  ]::text[],
  file_size_limit = 26214400
where id = 'pm-attachments';
