---
name: project-pending-media-restriction
description: Planned feature — reject audio calls, photo/video messages in the Telegram bot
metadata:
  type: project
---

Запланировано: добавить запрет на аудиозвонки и отправку фото/видео в боте.

**Why:** Бот предназначен только для текстового общения, медиа не поддерживается и должно отклоняться с коротким предупреждением.

**How to apply:** Реализовать отдельные handler'ы в `src/bot/handlers.ts` для `voice`, `video_note`, `photo`, `video`, `document` и `sticker` — отвечать фиксированным сообщением на русском/испанском.
